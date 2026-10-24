/**
 * brand_object_personas — ONE strict-schema LLM call over the live fact set.
 * Gates, in order: minimum evidence (>= personas.minVocFacts VOC facts +
 * >= minIdentityFacts identity facts, else SKIPPED — no LLM call, synthesis
 * `skipped` posture), pack fingerprint + cooldown, monthly budget cap.
 * Return gates are mechanical: unknown fact ids drop, verbatims must be
 * exact copies of pack-supplied quotes, ungrounded personas dissolve;
 * fewer than personas.min surviving = RETRYABLE failure (the model gets
 * another shot via max_attempts). Surviving personas are keyed by
 * statement-embedding match against the live persona facts (persona-keys.ts)
 * so a re-authored NAME supersedes its own identity instead of forking one;
 * stale auto personas retire on re-synthesis; founder-confirmed personas are
 * never touched.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_OBJECT_CONFIG } from '@/lib/brand-object/config';
import {
  computeCompleteness,
  deriveStatus,
} from '@/lib/brand-object/completeness';
import { buildPersonaPack } from '@/lib/brand-object/personas/pack';
import {
  getBrandObjectPersonaModel,
  PERSONAS_RESPONSE_FORMAT,
  personasResponseSchema,
  splitPersonaCandidates,
  validatePersonas,
} from '@/lib/brand-object/personas/prompt';
import { reconcileFacts } from '@/lib/brand-object/reconciler';
import { decodeChatJson } from '@/lib/brand-presence/llm';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import type { Job } from '../types';
import {
  executeReconcilePlan,
  loadLiveFacts,
  loadRejectedKeys,
  retireFacts,
} from './fact-writer';
import { keyPersonaCandidates } from './persona-keys';
import { enqueueBrandObjectChunks } from './queue';
import {
  assertBrandObjectBudget,
  ensureBrandObjectState,
  mergeBrandObjectState,
  recordBrandObjectUsage,
} from './state';
import { brandObjectPersonasPayloadSchema } from './types';

export class BrandObjectPersonasProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(job: Job, signal: AbortSignal): Promise<void> {
    const payload = brandObjectPersonasPayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId } = payload;
    const label = `[BrandObject] Personas ${brandProfileId}`;
    const cfg = BRAND_OBJECT_CONFIG.personas;

    const state = await ensureBrandObjectState(
      this._db,
      organizationId,
      brandProfileId,
    );

    const { data: profile, error: profileError } = await this._db
      .from('brand_presence_profiles')
      .select('brand_name, category')
      .eq('organization_id', organizationId)
      .eq('id', brandProfileId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) throw new Error(`Brand profile ${brandProfileId} not found`);

    // Personas ground in every non-persona live fact.
    const allLive = await loadLiveFacts(
      this._db,
      organizationId,
      brandProfileId,
    );
    const groundingFacts = allLive.filter(
      (fact) => fact.section !== 'persona',
    );
    const pack = buildPersonaPack(
      {
        name: String(profile.brand_name),
        category: (profile.category as string | null) ?? null,
      },
      groundingFacts,
    );

    if (
      pack.vocCount < cfg.minVocFacts ||
      pack.identityCount < cfg.minIdentityFacts
    ) {
      console.log(
        `${label}: skipped — ${pack.vocCount} VOC + ${pack.identityCount} identity facts ` +
          `(needs ${cfg.minVocFacts}+${cfg.minIdentityFacts}); no LLM call`,
      );
      await this.chainNext(payload, label);
      return;
    }

    const cursor = state.cursors?.personas ?? {};
    const lastRunAt = cursor.lastRunAt ? Date.parse(cursor.lastRunAt) : 0;
    const withinCooldown =
      Date.now() - lastRunAt < cfg.cooldownHours * 60 * 60 * 1000;
    if (cursor.packFingerprint === pack.fingerprint && withinCooldown) {
      console.log(`${label}: pack unchanged within cooldown — skipping LLM`);
      await this.chainNext(payload, label);
      return;
    }

    assertBrandObjectBudget(state);

    const completion = await openAIChatCompletion({
      body: {
        model: getBrandObjectPersonaModel(),
        messages: [
          { role: 'system', content: pack.system },
          {
            role: 'user',
            content: `${pack.user}\n\nBuild between ${cfg.min} and ${cfg.max} grounded personas, plus the unaware_projection when the facts support one.`,
          },
        ],
        response_format: PERSONAS_RESPONSE_FORMAT,
        temperature: 0.3,
        // Queue job, no human waiting → Flex tier (50% off).
        ...flexServiceTier(),
      },
      signal,
      retryProfile: 'background',
    });
    const usage = (
      completion as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }
    ).usage;
    await recordBrandObjectUsage(this._db, organizationId, brandProfileId, {
      llmCalls: 1,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    });

    const response = personasResponseSchema.parse(decodeChatJson(completion));
    const { candidates, droppedRefs, droppedVerbatims } = validatePersonas(
      response,
      pack,
    );
    // The unaware projection rides outside the grounded cap and min gate: it
    // must never evict an observed persona, and a run that grounded nothing
    // but the extrapolation still retries.
    const { grounded, capped } = splitPersonaCandidates(candidates, cfg.max);
    if (grounded.length < cfg.min) {
      throw new Error(
        `${label}: only ${grounded.length} grounded personas survived validation (need ${cfg.min}) — retrying`,
      );
    }

    const livePersonas = allLive.filter((fact) => fact.section === 'persona');
    // The model re-authors persona NAMES every run, so the name slug is not a
    // stable identity — match each candidate to the persona fact it already
    // owns by statement-embedding cosine before reconciling (fails open to
    // the slug).
    const keyed = await keyPersonaCandidates({
      candidates: capped,
      liveFacts: livePersonas,
      matchCosine: cfg.identityMatchCosine,
      signal,
      label,
    });
    const rejectedKeys = await loadRejectedKeys(
      this._db,
      organizationId,
      brandProfileId,
      livePersonas,
      ['persona'],
    );
    const plan = reconcileFacts({
      candidates: keyed,
      liveFacts: livePersonas,
      rejectedKeys,
    });
    const counts = await executeReconcilePlan(
      this._db,
      organizationId,
      brandProfileId,
      plan,
    );

    const freshKeys = new Set(
      keyed.map((candidate) => `persona:${candidate.factKey}`),
    );
    const retired = await retireFacts(
      this._db,
      organizationId,
      brandProfileId,
      livePersonas
        .filter(
          (fact) =>
            fact.status === 'candidate' &&
            fact.source === 'persona_synthesis' &&
            !freshKeys.has(`persona:${fact.factKey}`),
        )
        .map((fact) => fact.id),
    );

    const refreshed = await loadLiveFacts(
      this._db,
      organizationId,
      brandProfileId,
    );
    const completeness = computeCompleteness(refreshed);
    await mergeBrandObjectState(this._db, organizationId, brandProfileId, {
      status: deriveStatus(refreshed, completeness),
      completeness,
      cursors: {
        personas: {
          packFingerprint: pack.fingerprint,
          lastRunAt: new Date().toISOString(),
        },
      },
    });

    console.log(
      `${label}: ${counts.inserted} inserted, ${counts.superseded} superseded, ` +
        `${counts.suggested} suggested, ${counts.refreshed} refreshed, ${retired} retired ` +
        `(${droppedRefs} unknown fact refs + ${droppedVerbatims} unverified verbatims dropped)`,
    );
    await this.chainNext(payload, label);
  }

  private async chainNext(
    payload: { organizationId: string; brandProfileId: string },
    label: string,
  ): Promise<void> {
    const { jobId, deduped } = await enqueueBrandObjectChunks(this._db, {
      organizationId: payload.organizationId,
      brandProfileId: payload.brandProfileId,
    });
    console.log(
      `${label}: chunks ${deduped ? 'already queued' : 'queued'} (${jobId})`,
    );
  }
}

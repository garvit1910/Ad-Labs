/**
 * brand_object_promote — the Layer-3 VOC fact-promotion stage. ZERO LLM
 * calls. Reads the current theme layer + member phrases + mentions, builds
 * candidate facts (lib/brand-object/promotion.ts), assigns stable fact keys
 * by centroid matching against existing live facts, reconciles (confirmed
 * facts are never auto-superseded — contradictions become suggestions), and
 * executes the plan. Cluster-rebuild race guard: the theme layer's
 * cluster_run_id is read at start and re-read immediately before the write —
 * a mismatch means a rebuild raced us, so the job throws RETRYABLE and the
 * next attempt reads the fresh layer. Per-brand dedupe (bo_promote:{profile})
 * serializes promotes; keep runtime well under the zombie timeout.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_OBJECT_CONFIG } from '@/lib/brand-object/config';
import {
  computeCompleteness,
  deriveStatus,
} from '@/lib/brand-object/completeness';
import { assignFactKeys, meanVector } from '@/lib/brand-object/fact-key';
import {
  buildVocCandidates,
  type MentionForPromotion,
  type PhraseForPromotion,
  type QuoteForPromotion,
  type ThemeForPromotion,
  type VocCandidate,
} from '@/lib/brand-object/promotion';
import { reconcileFacts } from '@/lib/brand-object/reconciler';
import type {
  BrandSection,
  CandidateFact,
  LiveFact,
} from '@/lib/brand-object/types';
import {
  EMBEDDING_MODEL,
  parseVectorLiteral,
} from '@/services/ad-library/embeddings';
import type { Job } from '../types';
import {
  executeReconcilePlan,
  loadLiveFacts,
  loadRejectedKeys,
  retireFacts,
} from './fact-writer';
import { enqueueBrandObjectChunks, enqueueBrandObjectMarket } from './queue';
import { ensureBrandObjectState, mergeBrandObjectState } from './state';
import { brandObjectPromotePayloadSchema } from './types';

const FETCH_CHUNK = 200;
const IN_CHUNK = 150;
const VOC_SECTIONS: readonly BrandSection[] = [
  'voc_pain',
  'voc_desire',
  'voc_objection',
  'voc_praise',
];

export class BrandObjectPromoteProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(job: Job, signal: AbortSignal): Promise<void> {
    const payload = brandObjectPromotePayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId } = payload;
    const label = `[BrandObject] Promote ${brandProfileId}`;

    await ensureBrandObjectState(this._db, organizationId, brandProfileId);

    const startRunId = await this.readClusterRunId(
      organizationId,
      brandProfileId,
    );
    if (!startRunId) {
      console.log(`${label}: no theme layer yet, nothing to promote`);
      await this.finalize(organizationId, brandProfileId, null);
      return;
    }

    const themes = await this.loadThemes(organizationId, brandProfileId);
    const phrases = await this.loadMemberPhrases(
      organizationId,
      brandProfileId,
    );
    if (signal.aborted) throw new Error('Brand object job aborted');

    const memberMentionIds = [
      ...new Set(phrases.map((phrase) => phrase.mentionId)),
    ];
    const [quotes, mentionById] = await Promise.all([
      this.loadQuotes(organizationId, brandProfileId, memberMentionIds),
      this.loadMentions(organizationId, brandProfileId, memberMentionIds),
    ]);

    const candidates = buildVocCandidates({
      themes,
      phrases,
      quotes,
      mentionById,
      now: new Date(),
    });

    const liveVocFacts = await loadLiveFacts(
      this._db,
      organizationId,
      brandProfileId,
      VOC_SECTIONS,
    );
    const rejectedKeys = await loadRejectedKeys(
      this._db,
      organizationId,
      brandProfileId,
      liveVocFacts,
      VOC_SECTIONS,
    );
    const existingCentroids = await this.loadExistingFactCentroids(
      organizationId,
      brandProfileId,
      liveVocFacts,
    );

    const keyed = this.assignKeysBySection(
      candidates,
      liveVocFacts,
      existingCentroids,
    );
    const plan = reconcileFacts({
      candidates: keyed,
      liveFacts: liveVocFacts,
      rejectedKeys,
    });

    // Race guard: a rebuild that landed mid-run replaced every theme id we
    // snapshot as evidence — retry against the fresh layer instead.
    const endRunId = await this.readClusterRunId(
      organizationId,
      brandProfileId,
    );
    if (endRunId !== startRunId) {
      throw new Error(
        `${label}: cluster run changed mid-promotion (${startRunId} -> ${endRunId}), retrying`,
      );
    }

    const counts = await executeReconcilePlan(
      this._db,
      organizationId,
      brandProfileId,
      plan,
    );

    // Retire stale VOC candidates this promotion no longer produces (theme
    // dissolved on rebuild, or ranked out of the per-section top-N cap).
    // Confirmed facts NEVER retire — a confirmed fact whose theme faded stays
    // live; rejected identities stay suppressed via loadRejectedKeys. Sits
    // after the endRunId race guard, inside the same guarded write window as
    // the plan execution; retireFacts re-guards status='candidate' so a
    // concurrent founder confirm wins the race harmlessly.
    const freshKeys = new Set(
      keyed.map((candidate) => `${candidate.section}:${candidate.factKey}`),
    );
    const staleIds = liveVocFacts
      .filter(
        (fact) =>
          fact.status === 'candidate' &&
          fact.source === 'voc_promotion' &&
          !freshKeys.has(`${fact.section}:${fact.factKey}`),
      )
      .map((fact) => fact.id);
    const retired = await retireFacts(
      this._db,
      organizationId,
      brandProfileId,
      staleIds,
    );

    await this.finalize(organizationId, brandProfileId, startRunId);

    const { jobId, deduped } = await enqueueBrandObjectChunks(this._db, {
      organizationId,
      brandProfileId,
    });
    console.log(
      `${label}: ${counts.inserted} inserted, ${counts.superseded} superseded, ` +
        `${counts.suggested} suggested, ${counts.refreshed} refreshed, ` +
        `${retired} retired over ` +
        `${themes.length} themes / ${phrases.length} phrases (run ${startRunId}); ` +
        `chunks ${deduped ? 'already queued' : 'queued'} (${jobId})`,
    );
    if (payload.chain) {
      const market = await enqueueBrandObjectMarket(this._db, {
        organizationId,
        brandProfileId,
        chain: true,
      });
      console.log(
        `${label}: market ${market.deduped ? 'already queued' : 'queued'} (${market.jobId})`,
      );
    }
  }

  /** Assign stable fact keys per section (identity never crosses sections). */
  private assignKeysBySection(
    candidates: VocCandidate[],
    liveFacts: LiveFact[],
    centroidByFactKey: Map<string, number[]>,
  ): CandidateFact[] {
    const bySection = new Map<BrandSection, VocCandidate[]>();
    for (const candidate of candidates) {
      const list = bySection.get(candidate.section);
      if (list) list.push(candidate);
      else bySection.set(candidate.section, [candidate]);
    }
    const keyed: CandidateFact[] = [];
    for (const [section, sectionCandidates] of bySection) {
      const existing = liveFacts
        .filter((fact) => fact.section === section)
        .map((fact) => ({
          factKey: fact.factKey,
          centroid: centroidByFactKey.get(`${section}:${fact.factKey}`),
        }));
      const assigned = assignFactKeys(
        sectionCandidates.map((candidate) => ({
          label: candidate.themeLabel,
          centroid: candidate.centroid,
        })),
        existing,
        { matchCosine: BRAND_OBJECT_CONFIG.promotion.factMatchCosine },
      );
      sectionCandidates.forEach((candidate, i) => {
        keyed.push({ ...candidate, factKey: assigned[i].factKey });
      });
    }
    return keyed;
  }

  /** Existing facts' centroids, recomputed live from their stored
   * matchPhraseIds (phrases are never deleted; same-model vectors only). */
  private async loadExistingFactCentroids(
    organizationId: string,
    brandProfileId: string,
    liveFacts: LiveFact[],
  ): Promise<Map<string, number[]>> {
    const wanted = new Map<string, string[]>();
    const allPhraseIds: string[] = [];
    for (const fact of liveFacts) {
      const ids = (fact.details as { matchPhraseIds?: unknown })
        .matchPhraseIds;
      if (!Array.isArray(ids) || ids.length === 0) continue;
      const stringIds = ids.filter((id): id is string => typeof id === 'string');
      wanted.set(`${fact.section}:${fact.factKey}`, stringIds);
      allPhraseIds.push(...stringIds);
    }
    if (allPhraseIds.length === 0) return new Map();

    const vectorById = new Map<string, number[]>();
    const uniqueIds = [...new Set(allPhraseIds)];
    for (let i = 0; i < uniqueIds.length; i += IN_CHUNK) {
      const chunk = uniqueIds.slice(i, i + IN_CHUNK);
      const { data, error } = await this._db
        .from('brand_presence_phrases')
        .select('id, embedding, embedding_model')
        .eq('organization_id', organizationId)
        .eq('brand_profile_id', brandProfileId)
        .in('id', chunk);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.embedding_model && row.embedding_model !== EMBEDDING_MODEL) {
          continue; // never mix coordinate spaces
        }
        const vector = parseVectorLiteral(row.embedding);
        if (vector) vectorById.set(String(row.id), vector);
      }
    }

    const centroids = new Map<string, number[]>();
    for (const [key, ids] of wanted) {
      const vectors = ids
        .map((id) => vectorById.get(id))
        .filter((v): v is number[] => Boolean(v));
      const centroid = meanVector(vectors);
      if (centroid) centroids.set(key, centroid);
    }
    return centroids;
  }

  private async readClusterRunId(
    organizationId: string,
    brandProfileId: string,
  ): Promise<string | null> {
    const { data, error } = await this._db
      .from('brand_presence_themes')
      .select('cluster_run_id')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .limit(1);
    if (error) throw error;
    return data?.[0]?.cluster_run_id
      ? String(data[0].cluster_run_id)
      : null;
  }

  private async loadThemes(
    organizationId: string,
    brandProfileId: string,
  ): Promise<ThemeForPromotion[]> {
    const { data, error } = await this._db
      .from('brand_presence_themes')
      .select('id, kind, scope, label, summary, is_catchall, mention_count')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId);
    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      scope: String(row.scope),
      label: String(row.label),
      summary: (row.summary as string | null) ?? null,
      isCatchall: Boolean(row.is_catchall),
      mentionCount: Number(row.mention_count ?? 0),
    }));
  }

  /** Themed, embedded, same-model member phrases (keyset-paged; vector
   * literals are ~15-20KB per row). */
  private async loadMemberPhrases(
    organizationId: string,
    brandProfileId: string,
  ): Promise<PhraseForPromotion[]> {
    const cap = BRAND_OBJECT_CONFIG.promotion.maxPhrases;
    const out: PhraseForPromotion[] = [];
    let lastId: string | null = null;
    while (out.length < cap) {
      let query = this._db
        .from('brand_presence_phrases')
        .select('id, theme_id, mention_id, kind, phrase, embedding, embedding_model')
        .eq('organization_id', organizationId)
        .eq('brand_profile_id', brandProfileId)
        .neq('kind', 'quote')
        .not('theme_id', 'is', null)
        .order('id', { ascending: true })
        .limit(FETCH_CHUNK);
      if (lastId) query = query.gt('id', lastId);
      const { data, error } = await query;
      if (error) throw error;
      const page = data ?? [];
      for (const row of page) {
        const sameModel =
          !row.embedding_model || row.embedding_model === EMBEDDING_MODEL;
        const vector = sameModel
          ? (parseVectorLiteral(row.embedding) ?? undefined)
          : undefined;
        out.push({
          id: String(row.id),
          themeId: row.theme_id ? String(row.theme_id) : null,
          mentionId: String(row.mention_id),
          kind: String(row.kind),
          phrase: String(row.phrase),
          vector,
        });
      }
      if (page.length < FETCH_CHUNK) break;
      lastId = String(page[page.length - 1].id);
    }
    if (out.length >= cap) {
      console.warn(
        `[BrandObject] Promote ${brandProfileId}: phrase cap ${cap} reached — excess phrases not promoted this run`,
      );
    }
    return out;
  }

  private async loadQuotes(
    organizationId: string,
    brandProfileId: string,
    mentionIds: string[],
  ): Promise<QuoteForPromotion[]> {
    const out: QuoteForPromotion[] = [];
    for (let i = 0; i < mentionIds.length; i += IN_CHUNK) {
      const chunk = mentionIds.slice(i, i + IN_CHUNK);
      const { data, error } = await this._db
        .from('brand_presence_phrases')
        .select('id, mention_id, phrase')
        .eq('organization_id', organizationId)
        .eq('brand_profile_id', brandProfileId)
        .eq('kind', 'quote')
        .in('mention_id', chunk);
      if (error) throw error;
      for (const row of data ?? []) {
        out.push({
          id: String(row.id),
          mentionId: String(row.mention_id),
          phrase: String(row.phrase),
        });
      }
    }
    return out;
  }

  private async loadMentions(
    organizationId: string,
    brandProfileId: string,
    mentionIds: string[],
  ): Promise<Map<string, MentionForPromotion>> {
    const out = new Map<string, MentionForPromotion>();
    for (let i = 0; i < mentionIds.length; i += IN_CHUNK) {
      const chunk = mentionIds.slice(i, i + IN_CHUNK);
      const { data, error } = await this._db
        .from('brand_mentions')
        .select('id, platform, url, posted_at')
        .eq('organization_id', organizationId)
        .eq('brand_profile_id', brandProfileId)
        .in('id', chunk);
      if (error) throw error;
      for (const row of data ?? []) {
        out.set(String(row.id), {
          id: String(row.id),
          platform: String(row.platform),
          url: (row.url as string | null) ?? null,
          postedAt: (row.posted_at as string | null) ?? null,
        });
      }
    }
    return out;
  }

  /** Cursor + completeness/status update after a successful pass. */
  private async finalize(
    organizationId: string,
    brandProfileId: string,
    clusterRunId: string | null,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const { data: newest, error: newestError } = await this._db
      .from('brand_presence_phrases')
      .select('created_at')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (newestError) throw newestError;

    const allLive = await loadLiveFacts(
      this._db,
      organizationId,
      brandProfileId,
    );
    const completeness = computeCompleteness(allLive);
    await mergeBrandObjectState(this._db, organizationId, brandProfileId, {
      status: deriveStatus(allLive, completeness),
      completeness,
      cursors: {
        promotion: {
          clusterRunId,
          phraseWatermark: newest?.[0]?.created_at
            ? String(newest[0].created_at)
            : null,
          lastRunAt: nowIso,
        },
      },
    });
  }
}

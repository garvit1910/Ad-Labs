import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import {
  extractMentionSignals,
  getExtractModel,
  validateVerbatimQuotes,
  type ExtractBrandCard,
  type ExtractedPhrase,
  type MentionExtractVerdict,
} from '@/lib/brand-presence/extract';
import type {
  MentionInsight,
  MentionScope,
  MentionTags,
  PhraseKind,
  PhraseScope,
} from '@/lib/brand-presence/types';
import {
  EMBEDDING_MODEL,
  embedTexts,
  toPgVectorLiteral,
} from '@/services/ad-library/embeddings';
import type { Job } from '../types';
import {
  enqueueClusterIfAnalysisDrained,
  enqueueExtractBatches,
  gatherExtractEligibleIds,
} from './queue';
import { brandPresenceExtractPayloadSchema } from './types';

/**
 * Per-platform extraction-context builders — declarative, so no platform
 * branching leaks into extract.ts itself. TikTok comments are short and
 * context-dependent ("does it work on the second one?" is meaningless
 * without the video), so the parent video's caption (stored on
 * parent_title by the harvest normalizer) rides along as interpretation
 * context. Platforms without an entry get null — behavior unchanged.
 */
const EXTRACT_CONTEXT_BUILDERS: Record<
  string,
  (mention: { parent_title: string | null }) => string | null
> = {
  tiktok: (mention) =>
    mention.parent_title
      ? `Comment on a video captioned: "${mention.parent_title.slice(0, 200)}"`
      : null,
  instagram: (mention) =>
    mention.parent_title
      ? `Comment on an Instagram post captioned: "${mention.parent_title.slice(0, 200)}"`
      : null,
};

/**
 * brand_presence_extract — the ONE analysis pass over kept mentions
 * (relevant | not_required), REPLACING the old brand_presence_insights job.
 * Per mention it writes:
 * - tags.insight (exact legacy shape — the Competitors/Category sections and
 *   the mentions/list competitor filter read this path). A pre-existing
 *   tags.insight is never overwritten (earlier verdicts came from the full
 *   model; re-extraction must not downgrade them).
 * - brand_presence_phrases rows (brand+category scopes only): atomic
 *   pains/desires/objections/praise with paraphrases, plus kind='quote'
 *   verbatims validated as EXACT substrings of the mention text. Idempotent
 *   via upsert on (mention_id, kind, content_hash) with ignoreDuplicates — a
 *   crash between phrase insert and the status update never duplicates.
 * - extraction (raw structured output, audit/debug) and
 *   extraction_status='done' (an empty extraction is a valid 'done').
 * Mentions the model skipped stay 'pending' for the next pass.
 *
 * Then it embeds one wave of unembedded phrases (paraphrase text,
 * text-embedding-3-small via the shared ad-library helper) and enqueues a
 * cluster rebuild when enough new signal accumulated or extraction drained.
 */
export class BrandPresenceExtractProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(job: Job, signal: AbortSignal): Promise<void> {
    const payload = brandPresenceExtractPayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, mentionIds } = payload;
    const label = `[BrandPresence] Extract ${job.id}`;

    const { data: mentions, error: mentionsError } = await this._db
      .from('brand_mentions')
      .select(
        'id, platform, scope, subreddit, title, body, rating, relevance, extraction_status, tags, parent_title',
      )
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .in('id', mentionIds);
    if (mentionsError) throw mentionsError;

    const eligible = (mentions ?? []).filter(
      (mention) =>
        (mention.relevance === 'relevant' ||
          mention.relevance === 'not_required') &&
        mention.extraction_status === 'pending',
    );
    if (eligible.length === 0) {
      console.log(`${label}: nothing eligible to extract`);
      await this.continueExtractionBudget(
        organizationId,
        brandProfileId,
        job.id,
        mentionIds,
        label,
      );
      await this.embedAndMaybeCluster(
        organizationId,
        brandProfileId,
        job.id,
        label,
        { signal },
      );
      return;
    }

    const card = await this.loadBrandCard(organizationId, brandProfileId);
    if (!card) {
      console.log(`${label}: profile missing, skipping`);
      return;
    }

    const byId = new Map(
      eligible.map((mention) => [String(mention.id), mention]),
    );
    const verdicts = await extractMentionSignals(
      card,
      eligible.map((mention) => ({
        mention_id: String(mention.id),
        platform: String(mention.platform),
        scope: mention.scope as MentionScope,
        subreddit: (mention.subreddit as string | null) ?? null,
        title: (mention.title as string | null) ?? null,
        body: (mention.body as string | null) ?? null,
        rating: mention.rating == null ? null : Number(mention.rating),
        context:
          EXTRACT_CONTEXT_BUILDERS[String(mention.platform)]?.({
            parent_title: (mention.parent_title as string | null) ?? null,
          }) ?? null,
      })),
      { signal, maxBodyChars: BRAND_PRESENCE_CONFIG.extract.maxBodyChars },
    );
    if (verdicts.length === 0) {
      console.warn(`${label}: LLM returned no valid extraction verdicts`);
      return;
    }

    const extractedAt = new Date().toISOString();
    const model = getExtractModel();
    let written = 0;
    let phrasesWritten = 0;
    const completedMentionIds: string[] = [];
    for (const verdict of verdicts) {
      const mention = byId.get(verdict.mention_id);
      if (!mention) continue;

      // Quotes: exact-substring gate against the real stored text.
      const rawText = [mention.title, mention.body]
        .filter((part): part is string => typeof part === 'string')
        .join('\n');
      const quotes = validateVerbatimQuotes(verdict.quotes, rawText);

      // Phrases only for brand/category scopes (competitor mentions get
      // tags.insight treatment only).
      if (mention.scope !== 'competitor') {
        const phraseScope: PhraseScope =
          mention.scope === 'brand' ? 'brand' : 'category';
        phrasesWritten += await this.upsertPhrases(
          organizationId,
          brandProfileId,
          verdict.mention_id,
          phraseScope,
          verdict,
          quotes,
        );
      }

      const existingTags = (mention.tags as MentionTags | null) ?? {};
      // Never downgrade an existing insight (earlier passes ran the full
      // model); first-time mentions get the merged verdict's insight.
      const insight: MentionInsight =
        existingTags.insight ??
        ({
          competitors: verdict.competitors,
          angle: verdict.angle,
          sentiment: verdict.sentiment,
          gist: verdict.gist,
          usable: verdict.usable,
          model,
          extractedAt,
        } satisfies MentionInsight);

      const { error: updateError } = await this._db
        .from('brand_mentions')
        .update({
          tags: { ...existingTags, insight },
          extraction: {
            sentiment: verdict.sentimentScore,
            pains: verdict.pains,
            desires: verdict.desires,
            objections: verdict.objections,
            praise: verdict.praise,
            quotes,
            model,
            extractedAt,
          },
          extraction_status: 'done',
        })
        .eq('id', verdict.mention_id)
        .eq('organization_id', organizationId)
        .eq('brand_profile_id', brandProfileId)
        // Concurrency guard: only a still-pending mention is decided here.
        .eq('extraction_status', 'pending');
      if (updateError) throw updateError;
      written++;
      completedMentionIds.push(verdict.mention_id);
    }
    console.log(
      `${label}: extracted ${written}/${eligible.length} mentions -> ${phrasesWritten} phrases (model=${model}, 1 LLM call)`,
    );

    await this.continueExtractionBudget(
      organizationId,
      brandProfileId,
      job.id,
      completedMentionIds,
      label,
    );
    await this.embedAndMaybeCluster(
      organizationId,
      brandProfileId,
      job.id,
      label,
      { signal },
    );
  }

  /** The last extract job in a wave either queues the next platform-budgeted
   * wave or marks preserved overflow rows skipped so clustering can drain. */
  private async continueExtractionBudget(
    organizationId: string,
    brandProfileId: string,
    currentJobId: string,
    completedMentionIds: string[],
    label: string,
  ): Promise<void> {
    const mentionIds = await gatherExtractEligibleIds(this._db, {
      organizationId,
      brandProfileId,
      excludeJobId: currentJobId,
      // The live query already excludes completed rows. This explicit list
      // also protects callers backed by a lagging replica; malformed verdicts
      // are deliberately absent so they remain eligible for retry.
      excludeMentionIds: completedMentionIds,
    });
    if (mentionIds.length > 0) {
      const { jobIds, deduped } = await enqueueExtractBatches(this._db, {
        organizationId,
        brandProfileId,
        mentionIds,
      });
      console.log(
        `${label}: queued next extraction wave (${jobIds.length} batches, ${deduped} deduped)`,
      );
      return;
    }
  }

  /** Phrase rows for one mention: the four clusterable kinds + verbatim
   * quotes. content_hash makes re-extraction idempotent. */
  private async upsertPhrases(
    organizationId: string,
    brandProfileId: string,
    mentionId: string,
    scope: PhraseScope,
    verdict: MentionExtractVerdict,
    quotes: string[],
  ): Promise<number> {
    const rows: Array<Record<string, unknown>> = [];
    const push = (
      kind: PhraseKind,
      phrase: string,
      paraphrase: string | null,
    ) => {
      rows.push({
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        mention_id: mentionId,
        kind,
        phrase,
        paraphrase,
        sentiment: verdict.sentimentScore,
        scope,
        content_hash: contentHash(kind, phrase),
      });
    };
    const kinds: Array<[PhraseKind, ExtractedPhrase[]]> = [
      ['pain', verdict.pains],
      ['desire', verdict.desires],
      ['objection', verdict.objections],
      ['praise', verdict.praise],
    ];
    for (const [kind, phrases] of kinds) {
      for (const entry of phrases) push(kind, entry.phrase, entry.paraphrase);
    }
    for (const quote of quotes) push('quote', quote, null);
    if (rows.length === 0) return 0;

    const { error } = await this._db
      .from('brand_presence_phrases')
      .upsert(rows, {
        onConflict: 'mention_id,kind,content_hash',
        ignoreDuplicates: true,
      });
    if (error) throw error;
    return rows.length;
  }

  /**
   * One embedding wave over the brand's unembedded clusterable phrases, then
   * the cluster trigger: rebuild only when extraction AND every discovery
   * source/relevance job have fully drained. This prevents repeated full
   * theme rebuilds while onboarding sources finish at different times.
   */
  private async embedAndMaybeCluster(
    organizationId: string,
    brandProfileId: string,
    currentJobId: string,
    label: string,
    opts: { signal?: AbortSignal },
  ): Promise<void> {
    const { data: unembedded, error: unembeddedError } = await this._db
      .from('brand_presence_phrases')
      .select('id, phrase, paraphrase')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .neq('kind', 'quote')
      .is('embedding', null)
      .limit(BRAND_PRESENCE_CONFIG.extract.maxEmbedPerRun);
    if (unembeddedError) throw unembeddedError;

    if ((unembedded ?? []).length > 0) {
      const phrases = unembedded ?? [];
      const vectors = await embedTexts(
        phrases.map((row) =>
          String((row.paraphrase as string | null) ?? row.phrase),
        ),
        { signal: opts.signal },
      );
      for (let i = 0; i < phrases.length; i++) {
        const { error } = await this._db
          .from('brand_presence_phrases')
          .update({
            embedding: toPgVectorLiteral(vectors[i]),
            // Model stamp (ad_embeddings precedent) — Layer 3 fact-identity
            // matching compares phrase vectors and must be able to detect a
            // model swap. Backfilled for pre-existing rows in migration 0131.
            embedding_model: EMBEDDING_MODEL,
          })
          .eq('id', phrases[i].id)
          .eq('organization_id', organizationId);
        if (error) throw error;
      }
      console.log(`${label}: embedded ${phrases.length} phrases`);
    }

    const cluster = await enqueueClusterIfAnalysisDrained(this._db, {
      organizationId,
      brandProfileId,
      excludeJobId: currentJobId,
    });
    if (cluster) {
      console.log(
        `${label}: cluster ${cluster.deduped ? 'already queued' : 'queued'} (${cluster.jobId}) — ${cluster.unthemedPhrases} unthemed phrases, drained=true`,
      );
    }
  }

  private async loadBrandCard(
    organizationId: string,
    brandProfileId: string,
  ): Promise<ExtractBrandCard | null> {
    const { data, error } = await this._db
      .from('brand_presence_profiles')
      .select('brand_name, category, competitors')
      .eq('id', brandProfileId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      brand_name: String(data.brand_name),
      category: (data.category as string | null) ?? null,
      competitors: Array.isArray(data.competitors)
        ? (data.competitors as unknown[]).filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    };
  }
}

function contentHash(kind: string, phrase: string): string {
  return createHash('sha256').update(`${kind}:${phrase}`).digest('hex');
}

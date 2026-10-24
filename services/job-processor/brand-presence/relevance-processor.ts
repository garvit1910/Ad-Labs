import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import {
  classifyMentionRelevanceCascaded,
  verdictToRelevance,
  type BrandDisambiguationCard,
} from '@/lib/brand-presence/relevance';
import type {
  MentionScope,
  ProfileMeta,
  SourceMeta,
} from '@/lib/brand-presence/types';
import {
  computeTermStats,
  type TermStatMention,
} from '@/services/brand-presence/reddit-term-stats';
import type { Job } from '../types';
import { finalizeIfDrained } from './relevance-finalize';
import { brandPresenceRelevancePayloadSchema } from './types';

/**
 * brand_presence_relevance — the gate between "the brand name appeared" and
 * "this is genuinely about the brand". Idempotent: already-decided mentions
 * are skipped, and mentions the model returned malformed/missing verdicts
 * for simply stay pending for the next batch. Also maintains the Run-A kill
 * rate: when >90% of the brand-search source's decided mentions are
 * irrelevant, the source is flagged genericBrandName (the UI surfaces a
 * notice — the brand name is too generic to search on). After a pass over
 * Reddit mentions it also rewrites the per-term kill rates that prune
 * homonym terms from later Reddit searches (`redditTermPrune`).
 */
/** 10 pages x 1,000 rows: enough decided Reddit mentions for a stable rate. */
const REDDIT_TERM_STATS_MAX_PAGES = 10;

export class BrandPresenceRelevanceProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(job: Job, signal: AbortSignal): Promise<void> {
    const payload = brandPresenceRelevancePayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, mentionIds } = payload;
    const label = `[BrandPresence] Relevance ${job.id}`;

    const { data: mentions, error: mentionsError } = await this._db
      .from('brand_mentions')
      .select(
        'id, external_id, data_type, scope, subreddit, platform, title, body, relevance',
      )
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .in('id', mentionIds);
    if (mentionsError) throw mentionsError;

    const pending = (mentions ?? []).filter(
      (mention) => mention.relevance === 'pending',
    );
    if (pending.length === 0) {
      console.log(`${label}: all mentions already decided, skipping`);
      // Still attempt finalize — this batch's mentions may have been the last
      // pending ones, decided by a concurrent batch.
      await finalizeIfDrained(this._db, organizationId, brandProfileId, label, {
        excludeJobId: String(job.id),
      });
      return;
    }

    const card = await this.loadDisambiguationCard(
      organizationId,
      brandProfileId,
    );
    if (!card) {
      console.log(`${label}: profile missing, skipping`);
      return;
    }

    const byId = new Map(pending.map((m) => [String(m.id), m]));
    const {
      verdicts,
      cheapJudged,
      escalated,
    } = await classifyMentionRelevanceCascaded(
      card,
      pending.map((mention) => ({
        mention_id: String(mention.id),
        scope: (mention.scope as MentionScope) ?? 'brand',
        platform: String(mention.platform ?? 'reddit'),
        subreddit: (mention.subreddit as string | null) ?? null,
        title: (mention.title as string | null) ?? null,
        body: (mention.body as string | null) ?? null,
      })),
      { signal },
    );
    console.log(
      `${label}: cascade judged ${cheapJudged} cheap, escalated ${escalated} to the full model`,
    );
    if (verdicts.length === 0) {
      throw new Error(
        `LLM relevance returned no valid verdicts for ${pending.length} mentions`,
      );
    }

    let kept = 0;
    for (const verdict of verdicts) {
      const relevance = verdictToRelevance(verdict);
      if (relevance === 'relevant') kept++;
      const { error: updateError } = await this._db
        .from('brand_mentions')
        .update({
          relevance,
          relevance_confidence: verdict.confidence,
          // Judged-out mentions are never extracted.
          ...(relevance === 'irrelevant'
            ? { extraction_status: 'skipped' }
            : {}),
        })
        .eq('id', verdict.mention_id)
        .eq('organization_id', organizationId)
        .eq('brand_profile_id', brandProfileId)
        // Guard: never overwrite a verdict decided by a concurrent batch.
        .eq('relevance', 'pending');
      if (updateError) throw updateError;

      // Thread propagation: an irrelevant brand POST is a homonym/off-topic
      // thread — its kept (not_required/pending) comment children are noise
      // too. Decided child verdicts are never touched.
      const mention = byId.get(verdict.mention_id);
      if (
        relevance === 'irrelevant' &&
        mention?.data_type === 'post' &&
        mention?.scope === 'brand'
      ) {
        await this.propagateIrrelevantThread(
          organizationId,
          brandProfileId,
          String(mention.external_id),
        );
      }
    }

    const killRate = (verdicts.length - kept) / verdicts.length;
    console.log(
      `${label}: judged ${verdicts.length}/${pending.length} mentions, kept ${kept} (kill rate ${(killRate * 100).toFixed(0)}%)`,
    );

    await this.maybeFlagGenericBrandName(organizationId, brandProfileId, label);
    if (pending.some((mention) => mention.platform === 'x')) {
      await this.maybeFlagXQueryStats(organizationId, brandProfileId, label);
    }
    if (pending.some((mention) => mention.platform === 'reddit')) {
      await this.updateRedditTermStats(organizationId, brandProfileId, label);
    }
    await finalizeIfDrained(this._db, organizationId, brandProfileId, label, {
      excludeJobId: String(job.id),
    });
  }

  /** Flip a judged-irrelevant brand post's kept children to irrelevant. */
  private async propagateIrrelevantThread(
    organizationId: string,
    brandProfileId: string,
    postExternalId: string,
  ): Promise<void> {
    const { error } = await this._db
      .from('brand_mentions')
      .update({ relevance: 'irrelevant', extraction_status: 'skipped' })
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .eq('parent_external_id', postExternalId)
      .in('relevance', ['pending', 'not_required']);
    if (error) throw error;
  }

  private async loadDisambiguationCard(
    organizationId: string,
    brandProfileId: string,
  ): Promise<BrandDisambiguationCard | null> {
    const { data, error } = await this._db
      .from('brand_presence_profiles')
      .select(
        'brand_name, name_variants, website_url, category, product_description, competitors',
      )
      .eq('id', brandProfileId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      brand_name: String(data.brand_name),
      name_variants: Array.isArray(data.name_variants)
        ? (data.name_variants as unknown[]).filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
      domain: String(data.website_url),
      category: (data.category as string | null) ?? null,
      product_description: (data.product_description as string | null) ?? null,
      competitors: Array.isArray(data.competitors)
        ? (data.competitors as unknown[]).filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    };
  }

  /**
   * Kill-rate flag over the Run-A (reddit_search) source's decided mentions.
   * Recomputed from totals each pass so it is idempotent and self-corrects
   * as more verdicts land.
   */
  private async maybeFlagGenericBrandName(
    organizationId: string,
    brandProfileId: string,
    label: string,
  ): Promise<void> {
    const { data: source, error: sourceError } = await this._db
      .from('brand_presence_sources')
      .select('id, meta')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .eq('source_type', 'reddit_search')
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) return;

    const counts = await Promise.all(
      (['relevant', 'irrelevant'] as const).map(async (relevance) => {
        const { count, error } = await this._db
          .from('brand_mentions')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('brand_profile_id', brandProfileId)
          .eq('source_id', source.id)
          .eq('relevance', relevance);
        if (error) throw error;
        return count ?? 0;
      }),
    );
    const [relevant, irrelevant] = counts;
    const decided = relevant + irrelevant;
    if (decided < BRAND_PRESENCE_CONFIG.killRateMinSample) return;

    const killRate = irrelevant / decided;
    const shouldFlag = killRate > BRAND_PRESENCE_CONFIG.killRateFlagThreshold;
    const meta: SourceMeta = { ...((source.meta as SourceMeta) ?? {}) };
    const currentlyFlagged = meta.flags?.genericBrandName === true;
    if (shouldFlag === currentlyFlagged) return;

    meta.flags = { ...(meta.flags ?? {}), genericBrandName: shouldFlag };
    if (!shouldFlag) delete meta.flags.genericBrandName;
    const { error: updateError } = await this._db
      .from('brand_presence_sources')
      .update({ meta, updated_at: new Date().toISOString() })
      .eq('id', source.id)
      .eq('organization_id', organizationId);
    if (updateError) throw updateError;
    if (shouldFlag) {
      console.warn(
        `${label}: brand-search kill rate ${(killRate * 100).toFixed(0)}% over ${decided} decided — flagged genericBrandName`,
      );
    }
  }

  /**
   * Per-term Reddit kill rates over every decided Reddit mention of the brand
   * (brand scope for name variants, competitor scope for competitors),
   * recomputed from totals so it is idempotent and self-correcting. Stored on
   * the profile because one variant feeds several sources. Best-effort: it is
   * a cost lever, so a failure warns instead of failing a batch whose
   * verdicts are already written.
   */
  private async updateRedditTermStats(
    organizationId: string,
    brandProfileId: string,
    label: string,
  ): Promise<void> {
    if (!BRAND_PRESENCE_CONFIG.redditTermPrune.enabled) return;
    try {
      const { data: profile, error: profileError } = await this._db
        .from('brand_presence_profiles')
        .select('name_variants, competitors, meta')
        .eq('id', brandProfileId)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (profileError) throw profileError;
      if (!profile) return;

      const brandRows: TermStatMention[] = [];
      const competitorRows: TermStatMention[] = [];
      // PostgREST caps a read at 1,000 rows, so page explicitly.
      const pageSize = 1000;
      for (let page = 0; page < REDDIT_TERM_STATS_MAX_PAGES; page += 1) {
        const { data: rows, error } = await this._db
          .from('brand_mentions')
          .select('id, data_type, scope, title, body, relevance')
          .eq('organization_id', organizationId)
          .eq('brand_profile_id', brandProfileId)
          .eq('platform', 'reddit')
          .in('relevance', ['relevant', 'irrelevant'])
          .in('scope', ['brand', 'competitor'])
          .order('id', { ascending: true })
          .range(page * pageSize, page * pageSize + pageSize - 1);
        if (error) throw error;
        for (const row of rows ?? []) {
          (row.scope === 'brand' ? brandRows : competitorRows).push(
            row as TermStatMention,
          );
        }
        if ((rows ?? []).length < pageSize) break;
      }

      const asTerms = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : [];
      const variants = computeTermStats(brandRows, asTerms(profile.name_variants));
      const competitors = computeTermStats(
        competitorRows,
        asTerms(profile.competitors),
      );

      const meta: ProfileMeta = { ...((profile.meta as ProfileMeta) ?? {}) };
      const previous = meta.redditTermStats;
      if (
        previous &&
        JSON.stringify(previous.variants) === JSON.stringify(variants) &&
        JSON.stringify(previous.competitors) === JSON.stringify(competitors)
      ) {
        return;
      }
      meta.redditTermStats = {
        variants,
        competitors,
        computedAt: new Date().toISOString(),
      };
      const { error: updateError } = await this._db
        .from('brand_presence_profiles')
        .update({ meta })
        .eq('id', brandProfileId)
        .eq('organization_id', organizationId);
      if (updateError) throw updateError;

      const flagged = [
        ...Object.entries(variants),
        ...Object.entries(competitors),
      ]
        .filter(([, stat]) => stat.flagged)
        .map(([term, stat]) => `${term} (${stat.decided - stat.relevant}/${stat.decided} irrelevant)`);
      if (flagged.length > 0) {
        console.warn(
          `${label}: Reddit terms pruned as homonyms: ${flagged.join(', ')}`,
        );
      }
    } catch (error) {
      console.warn(
        `${label}: Reddit term stats not updated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Per-query kill rate for the X source's VARIANT tier (handle-tier
   * mentions never reach the gate). Recomputed from totals each pass —
   * idempotent, self-correcting. A flagged query means that name variant is
   * too generic for X keyword search (only the handle query is trustworthy);
   * when EVERY sampled variant query is flagged, the source carries the
   * shared genericBrandName flag the UI already knows how to surface.
   */
  private async maybeFlagXQueryStats(
    organizationId: string,
    brandProfileId: string,
    label: string,
  ): Promise<void> {
    const { data: source, error: sourceError } = await this._db
      .from('brand_presence_sources')
      .select('id, meta')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .eq('source_type', 'x')
      .maybeSingle();
    if (sourceError) throw sourceError;
    const meta: SourceMeta = { ...((source?.meta as SourceMeta) ?? {}) };
    if (!source || !meta.x) return;

    const { data: decidedRows, error: decidedError } = await this._db
      .from('brand_mentions')
      .select('relevance, tags')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .eq('platform', 'x')
      .in('relevance', ['relevant', 'irrelevant'])
      .contains('tags', { x: { tier: 'variant' } })
      .limit(5000);
    if (decidedError) throw decidedError;
    if (!decidedRows || decidedRows.length === 0) return;

    const { flagThreshold, minSample } = BRAND_PRESENCE_CONFIG.x.queryKillRate;
    const byTerm = new Map<string, { decided: number; relevant: number }>();
    for (const row of decidedRows) {
      const tags = row.tags as { x?: { matchedTerm?: string } } | null;
      const term = tags?.x?.matchedTerm ?? '(unattributed)';
      const entry = byTerm.get(term) ?? { decided: 0, relevant: 0 };
      entry.decided += 1;
      if (row.relevance === 'relevant') entry.relevant += 1;
      byTerm.set(term, entry);
    }

    const queryStats: NonNullable<SourceMeta['x']>['queryStats'] = {};
    let sampledTerms = 0;
    let flaggedTerms = 0;
    for (const [term, entry] of byTerm) {
      const killRate = (entry.decided - entry.relevant) / entry.decided;
      const flagged = entry.decided >= minSample && killRate > flagThreshold;
      queryStats[term] = {
        decided: entry.decided,
        relevant: entry.relevant,
        killRate: Number(killRate.toFixed(3)),
        flagged,
      };
      if (entry.decided >= minSample) sampledTerms += 1;
      if (flagged) {
        flaggedTerms += 1;
        console.warn(
          `${label}: X query ${term} kill rate ${(killRate * 100).toFixed(0)}% over ${entry.decided} decided — too generic for X keyword search`,
        );
      }
    }

    meta.x = { ...meta.x, queryStats };
    const allFlagged = sampledTerms > 0 && flaggedTerms === sampledTerms;
    meta.flags = { ...(meta.flags ?? {}), genericBrandName: allFlagged };
    if (!allFlagged) delete meta.flags.genericBrandName;

    const { error: updateError } = await this._db
      .from('brand_presence_sources')
      .update({ meta, updated_at: new Date().toISOString() })
      .eq('id', source.id)
      .eq('organization_id', organizationId);
    if (updateError) throw updateError;
  }
}

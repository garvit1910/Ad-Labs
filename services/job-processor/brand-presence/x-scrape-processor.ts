import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type {
  MentionTags,
  SourceMeta,
  SourceSyncCheckpoint,
  XSourceMeta,
} from '@/lib/brand-presence/types';
import {
  buildXQuerySet,
  buildXSearchInput,
  type XQuerySet,
} from '@/services/brand-presence/x-actor-input';
import {
  XApifyProvider,
  XProviderError,
} from '@/services/brand-presence/x-apify-provider';
import {
  normalizeXItem,
  type NormalizedXMention,
} from '@/services/brand-presence/x-normalizer';
import { containsNameVariant } from '@/services/brand-presence/reddit-normalizer';
import { r2Service } from '@/services/r2-service';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import {
  enqueueExtractOrDrainCluster,
  enqueueRelevanceBatches,
} from './queue';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceXScrapePayloadSchema } from './types';

const R2_BUCKET = 'adcero-ad-creatives';
const UPSERT_CHUNK_SIZE = 100;

interface SourceRow {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_type: string;
  meta: SourceMeta | null;
}

/**
 * brand_presence_x_scrape — the X saved-search runner (ONE JOB PER SOURCE,
 * one x source per brand). A scrape is up to two sequential actor runs
 * because the actor's maxItems is a GLOBAL per-run cap:
 *
 *   phase 'handle'   — `@{handle} -from:{handle} -filter:retweets` alone,
 *                      with its own cap, so a generic name variant can never
 *                      starve the high-precision tier. Skipped on the
 *                      name-search-only path.
 *   phase 'variants' — all quoted name-variant queries batched in one run
 *                      (includeSearchTerms echoes the matching query per
 *                      item for per-query kill-rate attribution).
 *
 * EVERY X mention is relevance-gated (relevance='pending') before extraction
 * tokens are spent — live data showed even handle-tier tweets (someone
 * tagging the account) are dense with giveaway/promo replies, and keyword
 * matches with marketing name-drops, so X is gated wholesale with the
 * VOC-focused gate prompt. The tier survives in tags.x as query attribution
 * (per-variant kill-rate stats). Refresh
 * runs inject `since:` from meta.cursor.lastPostedAt into the query strings
 * and use the shallow caps. Raw pages archive to R2; crash-resume state
 * lives in source.meta.sync (Reddit contract: persist runId/datasetId
 * immediately after start, resume by scopeKey, page the dataset by offset).
 * A zero-item SUCCESS is expected for small brands (recorded in
 * meta.x.lastRun, surfaced as "X is quiet"), not actor breakage.
 */
export class BrandPresenceXScrapeProcessor {
  private providerInstance: XApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: XApifyProvider,
  ) {
    this.providerInstance = provider ?? null;
  }

  private get provider(): XApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new XApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceXScrapePayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, sourceId, refresh } = payload;
    const label = `[BrandPresence] XScrape ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source || source.source_type !== 'x') {
      console.log(`${label}: source missing, skipping`);
      return;
    }
    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const xMeta = meta.x;
    if (!xMeta?.confirmedAt) {
      // The founder gate — never run the saved searches unconfirmed.
      console.log(`${label}: handle not confirmed, skipping`);
      return;
    }

    const nameVariants = await this.loadNameVariants(
      organizationId,
      brandProfileId,
    );
    if (nameVariants === null) {
      console.log(`${label}: profile missing, skipping`);
      return;
    }

    const handle = xMeta.nameSearchOnly ? null : xMeta.handle;
    const refreshFloor = refresh ? (meta.cursor?.lastPostedAt ?? null) : null;
    const queries = buildXQuerySet({
      handle,
      nameVariants,
      sinceDate: refreshFloor,
    });

    const scopeKey = this.buildScopeKey(queries, refresh);
    let sync: SourceSyncCheckpoint;
    if (meta.sync && meta.sync.scopeKey === scopeKey) {
      sync = meta.sync;
      console.log(
        `${label}: resuming (phase=${sync.phase}, runId=${sync.runId ?? 'none'}, offset=${sync.datasetOffset})`,
      );
    } else {
      sync = {
        scopeKey,
        startedAt: new Date().toISOString(),
        phase: queries.handleQuery ? 'handle' : 'variants',
        runId: null,
        datasetId: null,
        runStartedAt: null,
        datasetOffset: 0,
        page: 0,
        maxPostedAt: meta.cursor?.lastPostedAt ?? null,
        counts: { upserted: 0, skipped: 0, filtered: 0, shortText: 0 },
      };
    }
    meta.sync = sync;
    await this.persistSource(source, meta, { status: 'running' });

    try {
      if (!queries.handleQuery && queries.variantQueries.length === 0) {
        // Nothing searchable (empty variant list on the no-handle path) —
        // finalize as a quiet zero-item pass rather than erroring.
        console.warn(`${label}: no queries to run (empty query set)`);
        await this.finalize(source, meta, xMeta, sync, String(job.id), label);
        return;
      }

      for (;;) {
        if (signal.aborted) throw new Error('Brand presence job aborted');

        const phaseQueries =
          sync.phase === 'handle' && queries.handleQuery
            ? [queries.handleQuery]
            : queries.variantQueries;
        if (phaseQueries.length === 0) break;

        // Start this phase's run if none is checkpointed. Persist the ids in
        // the very next await — that window is the only unavoidable orphan.
        if (!sync.runId) {
          const input = buildXSearchInput(phaseQueries, {
            maxItems: this.phaseMaxItems(sync.phase, refresh),
          });
          const handleIds = await this.provider.startRun(input);
          sync.runId = handleIds.runId;
          sync.datasetId = handleIds.datasetId;
          sync.runStartedAt = new Date().toISOString();
          sync.datasetOffset = 0;
          await this.persistSource(source, meta);
          console.log(
            `${label}: started run ${handleIds.runId} (phase=${sync.phase}, queries=${phaseQueries.length})`,
          );
        }

        const outcome = await awaitRunCompletion({
          provider: this.provider,
          runId: sync.runId,
          runStartedAt: sync.runStartedAt ?? sync.startedAt,
          signal,
          timeoutTracker,
          label,
        });
        if (outcome.outcome === 'failed') {
          // Clear the dead run so a job retry starts a fresh one (the wedged
          // path already aborted it).
          sync.runId = null;
          sync.datasetId = null;
          sync.runStartedAt = null;
          await this.persistSource(source, meta);
          throw new XProviderError(
            `X scraper run failed (phase=${sync.phase}${outcome.wedged ? ', wedged' : ''})`,
            { retryable: outcome.retryable },
          );
        }

        await this.ingestDataset(
          source,
          sync,
          meta,
          { handle, nameVariants, refreshFloor },
          { signal, timeoutTracker, label },
        );

        // Handle phase done → the batched variant phase (when any exist).
        if (sync.phase === 'handle' && queries.variantQueries.length > 0) {
          sync.phase = 'variants';
          sync.runId = null;
          sync.datasetId = null;
          sync.runStartedAt = null;
          sync.datasetOffset = 0;
          await this.persistSource(source, meta);
          if (timeoutTracker?.shouldStop()) {
            throw new FunctionTimeoutError(
              'Function timeout - will resume on next cron',
            );
          }
          continue;
        }
        break;
      }

      await this.finalize(source, meta, xMeta, sync, String(job.id), label);
    } catch (error) {
      // Leave the checkpoint intact for timeouts (that is what resume is);
      // real failures record the error and surface status=error.
      if (!(error instanceof FunctionTimeoutError)) {
        meta.lastError = {
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        };
        await this.persistSource(source, meta, { status: 'error' }).catch(
          () => {},
        );
      }
      throw error;
    }
  }

  /** Per-phase item caps — the actor treats an UNSET maxItems as unlimited,
   * so every run gets an explicit one. */
  private phaseMaxItems(
    phase: SourceSyncCheckpoint['phase'],
    refresh: boolean,
  ): number {
    const { x } = BRAND_PRESENCE_CONFIG;
    if (phase === 'handle') {
      return refresh ? x.refresh.handleMaxItems : x.handleSearch.maxItems;
    }
    return refresh ? x.refresh.variantMaxItems : x.variantSearch.maxItems;
  }

  private async ingestDataset(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    meta: SourceMeta,
    ctx: {
      handle: string | null;
      nameVariants: string[];
      refreshFloor: string | null;
    },
    opts: {
      signal: AbortSignal;
      timeoutTracker?: FunctionTimeoutTracker;
      label: string;
    },
  ): Promise<void> {
    const { datasetPageSize } = BRAND_PRESENCE_CONFIG;
    if (!sync.datasetId) {
      throw new XProviderError(
        `Run ${sync.runId} succeeded but no datasetId was checkpointed`,
        { retryable: true },
      );
    }
    const tier = sync.phase === 'handle' ? 'handle' : 'variant';

    for (;;) {
      if (opts.signal.aborted) throw new Error('Brand presence job aborted');

      const items = await this.provider.listDatasetItems(
        sync.datasetId,
        sync.datasetOffset,
        datasetPageSize,
      );
      if (items.length === 0) break;

      const rawRef = await this.storeRawPage(source, sync, items);

      const mentions: NormalizedXMention[] = [];
      for (const raw of items) {
        const normalized = normalizeXItem(raw, {
          brandHandle: ctx.handle,
          tier,
        });
        if (normalized.kind !== 'mention') {
          sync.counts.skipped += 1;
          continue;
        }
        const mention = normalized.mention;
        // Ingest containment gate, variant tier only: X keyword search can
        // fuzz-match, and ungated keyword noise is exactly what this source
        // must never bill to the LLM. The @handle operator is exact, so the
        // handle tier has no gate (Reddit threads-phase precedent).
        if (
          tier === 'variant' &&
          !containsNameVariant(normalized.rawText, ctx.nameVariants)
        ) {
          sync.counts.filtered = (sync.counts.filtered ?? 0) + 1;
          continue;
        }
        // Cursor refresh: keep only strictly-newer tweets (belt-and-braces
        // over the day-granular since: operator).
        if (
          ctx.refreshFloor &&
          mention.posted_at &&
          mention.posted_at <= ctx.refreshFloor
        ) {
          sync.counts.skipped += 1;
          continue;
        }
        mentions.push(mention);
        if (!sync.maxPostedAt || mention.posted_at > sync.maxPostedAt) {
          sync.maxPostedAt = mention.posted_at;
        }
      }

      const { written, shortText } = await this.upsertMentions(
        source,
        mentions,
        rawRef,
      );
      sync.counts.upserted += written;
      sync.counts.shortText = (sync.counts.shortText ?? 0) + shortText;
      sync.datasetOffset += items.length;
      sync.page += 1;
      await this.persistSource(source, meta);

      if (items.length < datasetPageSize) break;
      if (opts.timeoutTracker?.shouldStop()) {
        throw new FunctionTimeoutError(
          'Function timeout - will resume on next cron',
        );
      }
    }
  }

  private async upsertMentions(
    source: SourceRow,
    mentions: NormalizedXMention[],
    rawRef: string | null,
  ): Promise<{ written: number; shortText: number }> {
    if (mentions.length === 0) return { written: 0, shortText: 0 };

    // In-batch dedupe — the handle tier wins (higher-precision provenance
    // for the per-query attribution stats).
    const byExternalId = new Map<string, NormalizedXMention>();
    for (const mention of mentions) {
      const existing = byExternalId.get(mention.external_id);
      if (!existing || (existing.tier === 'variant' && mention.tier === 'handle')) {
        byExternalId.set(mention.external_id, mention);
      }
    }
    const deduped = [...byExternalId.values()];

    let written = 0;
    let shortText = 0;
    for (let i = 0; i < deduped.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = deduped.slice(i, i + UPSERT_CHUNK_SIZE);
      const externalIds = chunk.map((mention) => mention.external_id);

      // Pre-read existing rows: replays must never clobber extract-pass tags
      // (tags.insight), reset a decided relevance verdict, or downgrade a
      // handle-tier row to a re-gated variant-tier one.
      const { data: existingRows, error: existingError } = await this._db
        .from('brand_mentions')
        .select('external_id, tags')
        .eq('organization_id', source.organization_id)
        .eq('brand_profile_id', source.brand_profile_id)
        .eq('platform', 'x')
        .in('external_id', externalIds);
      if (existingError) throw existingError;
      const existingTags = new Map(
        (existingRows ?? []).map((row) => [
          String(row.external_id),
          (row.tags as MentionTags | null) ?? {},
        ]),
      );

      const buildRow = (mention: NormalizedXMention) => {
        const prior = existingTags.get(mention.external_id);
        // A row already stored from the handle tier keeps that tier — the
        // higher-precision provenance must survive a variant-phase replay.
        const tierUpgradeBlocked =
          prior?.x?.tier === 'handle' && mention.tier === 'variant';
        return {
          organization_id: source.organization_id,
          brand_profile_id: source.brand_profile_id,
          source_id: source.id,
          platform: 'x',
          external_id: mention.external_id,
          data_type: mention.data_type,
          scope: 'brand',
          url: mention.url,
          subreddit: null,
          author_ref: mention.author_ref,
          title: null,
          body: mention.body,
          posted_at: mention.posted_at,
          parent_external_id: mention.parent_external_id,
          rating: null,
          raw_ref: rawRef,
          tags: {
            ...prior,
            x: tierUpgradeBlocked
              ? prior?.x
              : {
                  tier: mention.tier,
                  ...(mention.matched_term
                    ? { matchedTerm: mention.matched_term }
                    : {}),
                  ...mention.engagement,
                },
          },
        };
      };

      // Partitioned upserts (bulk rows must share one column set), and rows
      // that already exist OMIT relevance/extraction_status entirely so a
      // replay never resets a decided verdict or a skipped/done extraction.
      const existing = chunk.filter((m) => existingTags.has(m.external_id));
      const fresh = chunk.filter((m) => !existingTags.has(m.external_id));
      // "@brand 🔥" tweets store for provenance but never reach the LLM —
      // not even the relevance gate.
      const freshShort = fresh.filter((m) => m.short_text);
      const freshGated = fresh.filter((m) => !m.short_text);

      const upsert = async (rows: Record<string, unknown>[]) => {
        if (rows.length === 0) return;
        const { error } = await this._db
          .from('brand_mentions')
          .upsert(rows, { onConflict: 'brand_profile_id,platform,external_id' });
        if (error) throw error;
        written += rows.length;
      };

      await upsert(
        freshGated.map((m) => ({
          ...buildRow(m),
          // Every X mention — both tiers — goes through the LLM gate: X is
          // dense with promo/giveaway/affiliate spam even when the brand is
          // tagged directly.
          relevance: 'pending',
        })),
      );
      await upsert(
        freshShort.map((m) => ({
          ...buildRow(m),
          relevance: 'not_required',
          extraction_status: 'skipped',
        })),
      );
      await upsert(existing.map(buildRow));
      shortText += freshShort.length;
    }
    return { written, shortText };
  }

  /** Best-effort raw page archive (Layer-2 key convention). */
  private async storeRawPage(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    items: unknown[],
  ): Promise<string | null> {
    const key = `brand-presence/${source.organization_id}/${source.brand_profile_id}/${source.id}/x-${sync.phase}-${sync.startedAt}-page${sync.page}.json`;
    try {
      await r2Service.uploadFile(
        R2_BUCKET,
        key,
        JSON.stringify(items),
        'application/json',
        { source: 'brand-presence-x' },
      );
      return key;
    } catch (error) {
      console.warn(
        `[BrandPresence] Failed to store raw page ${key}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  /** Commit the cursor + last-run stats, clear the checkpoint, mark synced,
   * and hand every pending mention to the relevance gate (all X tiers are
   * gated; only short-text rows skip straight past extraction).
   * `currentJobId` is load-bearing: on the nothing-pending path this job may
   * be the LAST of the profile's pipeline, so it owns the final theme-rebuild
   * drain check (which must exclude its own processing row). */
  private async finalize(
    source: SourceRow,
    meta: SourceMeta,
    xMeta: XSourceMeta,
    sync: SourceSyncCheckpoint,
    currentJobId: string,
    label: string,
  ): Promise<void> {
    const zeroItems =
      sync.counts.upserted === 0 &&
      sync.counts.skipped === 0 &&
      (sync.counts.filtered ?? 0) === 0;
    if (zeroItems) {
      // Expected for small brands (X can genuinely be quiet) — recorded in
      // meta.x.lastRun for the panel; the loud log stays as the breakage
      // detector for brands that normally have volume.
      console.warn(`${label}: ZERO items returned across all phases`);
    }
    if (sync.maxPostedAt) {
      meta.cursor = { lastPostedAt: sync.maxPostedAt };
    }
    meta.x = {
      ...xMeta,
      lastRun: {
        finishedAt: new Date().toISOString(),
        upserted: sync.counts.upserted,
        filtered: sync.counts.filtered ?? 0,
        skippedShort: sync.counts.shortText ?? 0,
        zeroItems,
      },
    };
    delete meta.sync;
    delete meta.lastError;
    await this.persistSource(source, meta, {
      status: 'synced',
      last_synced_at: new Date().toISOString(),
    });

    // Queue the relevance gate over every still-pending mention of this
    // brand (batch dedupe keys absorb overlap with sibling scrapes).
    const { data: pending, error: pendingError } = await this._db
      .from('brand_mentions')
      .select('id')
      .eq('organization_id', source.organization_id)
      .eq('brand_profile_id', source.brand_profile_id)
      .eq('relevance', 'pending')
      .limit(2000);
    if (pendingError) throw pendingError;
    const mentionIds = (pending ?? []).map((row) => String(row.id));
    if (mentionIds.length > 0) {
      const { jobIds, deduped } = await enqueueRelevanceBatches(this._db, {
        organizationId: source.organization_id,
        brandProfileId: source.brand_profile_id,
        mentionIds,
      });
      console.log(
        `${label}: synced ${sync.counts.upserted} mentions (${sync.counts.filtered ?? 0} filtered, ${sync.counts.skipped} skipped, ${sync.counts.shortText ?? 0} short) -> ${jobIds.length} relevance batches (${deduped} deduped)`,
      );
    } else {
      // Nothing pending (e.g. a short-text-only page) — relevance
      // drain-finalize never fires, so enqueue phrase extraction directly, or
      // drain to the final theme rebuild when there is nothing left to
      // extract.
      const { extractIds } = await enqueueExtractOrDrainCluster(this._db, {
        organizationId: source.organization_id,
        brandProfileId: source.brand_profile_id,
        excludeJobId: currentJobId,
      });
      console.log(
        `${label}: synced ${sync.counts.upserted} mentions (${sync.counts.filtered ?? 0} filtered, ${sync.counts.skipped} skipped), none pending relevance -> ${extractIds.length} eligible for extraction`,
      );
    }
  }

  private buildScopeKey(queries: XQuerySet, refresh: boolean): string {
    const { x } = BRAND_PRESENCE_CONFIG;
    return createHash('sha256')
      .update(
        JSON.stringify({
          handleQuery: queries.handleQuery,
          variantQueries: queries.variantQueries,
          refresh,
          handleMaxItems: x.handleSearch.maxItems,
          variantMaxItems: x.variantSearch.maxItems,
          refreshCaps: x.refresh,
        }),
      )
      .digest('hex');
  }

  private async loadNameVariants(
    organizationId: string,
    brandProfileId: string,
  ): Promise<string[] | null> {
    const { data, error } = await this._db
      .from('brand_presence_profiles')
      .select('brand_name, name_variants')
      .eq('id', brandProfileId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const variants = Array.isArray(data.name_variants)
      ? data.name_variants.filter(
          (item): item is string => typeof item === 'string',
        )
      : [];
    const brandName =
      typeof data.brand_name === 'string' ? data.brand_name.trim() : '';
    if (brandName && !variants.some((v) => v.toLowerCase() === brandName.toLowerCase())) {
      variants.unshift(brandName);
    }
    return variants;
  }

  private async loadSource(
    organizationId: string,
    brandProfileId: string,
    sourceId: string,
  ): Promise<SourceRow | null> {
    const { data, error } = await this._db
      .from('brand_presence_sources')
      .select('id, organization_id, brand_profile_id, source_type, meta')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .eq('id', sourceId)
      .maybeSingle();
    if (error) throw error;
    return (data as SourceRow | null) ?? null;
  }

  private async persistSource(
    source: SourceRow,
    meta: SourceMeta,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this._db
      .from('brand_presence_sources')
      .update({
        meta,
        updated_at: new Date().toISOString(),
        ...extra,
      })
      .eq('id', source.id)
      .eq('organization_id', source.organization_id);
    if (error) throw error;
  }
}

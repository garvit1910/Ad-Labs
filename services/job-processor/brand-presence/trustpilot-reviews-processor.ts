import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type {
  MentionTags,
  SourceMeta,
  SourceSyncCheckpoint,
  TrustpilotPageMeta,
  TrustpilotSourceMeta,
} from '@/lib/brand-presence/types';
import {
  buildReviewsInput,
  type TrustpilotReviewsPhase,
} from '@/services/brand-presence/trustpilot-actor-input';
import {
  TrustpilotApifyProvider,
  TrustpilotProviderError,
} from '@/services/brand-presence/trustpilot-apify-provider';
import {
  extractCompanyFromItem,
  normalizeTrustpilotReviewItem,
  type NormalizedTrustpilotReview,
} from '@/services/brand-presence/trustpilot-normalizer';
import { r2Service } from '@/services/r2-service';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import { enqueueExtractOrDrainCluster } from './queue';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceTrustpilotReviewsPayloadSchema } from './types';

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
 * brand_presence_trustpilot_reviews — ONE JOB PER PAGE (one business unit per
 * source row). Runs the memo23 Trustpilot actor for the founder-confirmed
 * page. A backfill is up to two sequential runs (checkpoint phase
 * backfill_negative → backfill_full): the 1–2★ pass runs first so pain-dense
 * reviews survive the cap, then an unfiltered newest-first pass. That first
 * pass is SKIPPED when reviewsCount <= backfillMaxItems (the unfiltered Run B
 * captures every negative anyway). Refresh runs a single enriched newest-first
 * pass bounded by startDate = the day-sliced posted_at cursor, and also
 * refreshes meta.trustpilot.page aggregates from the company block.
 *
 * Reviews land as platform='trustpilot', data_type='review', scope='brand',
 * relevance='not_required' with rating + tags.trustpilot (verified/country/
 * reply/likes; reply text is NEVER sent to extraction) — the founder confirmed
 * their own page, so there is no relevance gate. Fully text-empty reviews
 * (no title AND no body) go through a SECOND partitioned upsert with
 * extraction_status='skipped'; a title-only review IS extractable. Raw pages
 * archive to R2; crash-resume state lives in source.meta.sync (Reddit
 * contract); the cursor commits to meta.cursor.lastPostedAt at finalize.
 */
export class BrandPresenceTrustpilotReviewsProcessor {
  private providerInstance: TrustpilotApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: TrustpilotApifyProvider,
  ) {
    this.providerInstance = provider ?? null;
  }

  private get provider(): TrustpilotApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new TrustpilotApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceTrustpilotReviewsPayloadSchema.parse(
      job.payload,
    );
    const { organizationId, brandProfileId, sourceId, refresh } = payload;
    const label = `[BrandPresence] TrustpilotReviews ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source || source.source_type !== 'trustpilot') {
      console.log(`${label}: source missing, skipping`);
      return;
    }
    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const tp: TrustpilotSourceMeta = { ...(meta.trustpilot ?? {}) };
    meta.trustpilot = tp;
    const page = tp.page;
    if (!page?.confirmedAt) {
      // The founder gate — never scrape an unconfirmed page.
      console.log(`${label}: page not confirmed, skipping`);
      return;
    }

    // The refresh floor is the cursor as of job start (maxPostedAt advances
    // during ingest). Belt-and-braces on top of the actor's day-granular
    // startDate filter.
    const refreshFloor = refresh ? (meta.cursor?.lastPostedAt ?? null) : null;

    const scopeKey = this.buildScopeKey(page.url, page.domain, refresh);
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
        phase: this.initialPhase(refresh, page),
        runId: null,
        datasetId: null,
        runStartedAt: null,
        datasetOffset: 0,
        page: 0,
        maxPostedAt: meta.cursor?.lastPostedAt ?? null,
        counts: { upserted: 0, skipped: 0 },
      };
    }
    meta.sync = sync;
    await this.persistSource(source, meta, { status: 'running' });

    try {
      for (;;) {
        if (signal.aborted) throw new Error('Brand presence job aborted');

        // Start this phase's run if none is checkpointed. Persist the ids in
        // the very next await — that window is the only unavoidable orphan.
        if (!sync.runId) {
          const input = buildReviewsInput({
            url: page.url,
            phase: sync.phase as TrustpilotReviewsPhase,
            refreshCursor: refreshFloor,
          });
          const handle = await this.provider.startRun(input);
          sync.runId = handle.runId;
          sync.datasetId = handle.datasetId;
          sync.runStartedAt = new Date().toISOString();
          sync.datasetOffset = 0;
          await this.persistSource(source, meta);
          console.log(
            `${label}: started run ${handle.runId} (phase=${sync.phase})`,
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
          throw new TrustpilotProviderError(
            `Trustpilot reviews run failed (phase=${sync.phase}${outcome.wedged ? ', wedged' : ''})`,
            { retryable: outcome.retryable },
          );
        }

        await this.ingestDataset(source, sync, meta, page, refreshFloor, {
          signal,
          timeoutTracker,
          label,
        });

        // 1–2★ pass done → the unfiltered pass captures everything else.
        if (sync.phase === 'backfill_negative') {
          sync.phase = 'backfill_full';
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

      await this.finalize(source, meta, tp, sync, String(job.id), label);
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

  /** Refresh → single enriched pass. Fresh → skip the 1–2★ pass when the page
   * has few enough reviews that the unfiltered pass captures every negative. */
  private initialPhase(
    refresh: boolean,
    page: TrustpilotPageMeta,
  ): SourceSyncCheckpoint['phase'] {
    if (refresh) return 'refresh';
    const { backfillMaxItems } = BRAND_PRESENCE_CONFIG.trustpilot;
    return page.reviewsCount != null && page.reviewsCount <= backfillMaxItems
      ? 'backfill_full'
      : 'backfill_negative';
  }

  private async ingestDataset(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    meta: SourceMeta,
    page: TrustpilotPageMeta,
    refreshFloor: string | null,
    opts: {
      signal: AbortSignal;
      timeoutTracker?: FunctionTimeoutTracker;
      label: string;
    },
  ): Promise<void> {
    const { datasetPageSize } = BRAND_PRESENCE_CONFIG;
    if (!sync.datasetId) {
      throw new TrustpilotProviderError(
        `Run ${sync.runId} succeeded but no datasetId was checkpointed`,
        { retryable: true },
      );
    }

    for (;;) {
      if (opts.signal.aborted) throw new Error('Brand presence job aborted');

      const items = await this.provider.listDatasetItems(
        sync.datasetId,
        sync.datasetOffset,
        datasetPageSize,
      );
      if (items.length === 0) break;

      // Refresh runs carry the company block — keep the page aggregates fresh.
      if (sync.phase === 'refresh') {
        const company = extractCompanyFromItem(items[0]);
        if (company) {
          meta.trustpilot = {
            ...(meta.trustpilot ?? {}),
            page: {
              ...page,
              ...(company.trustScore !== null
                ? { trustScore: company.trustScore }
                : {}),
              ...(company.reviewsCount !== null
                ? { reviewsCount: company.reviewsCount }
                : {}),
              ...(Object.keys(company.starDistribution).length > 0
                ? { starDistribution: company.starDistribution }
                : {}),
            },
          };
        }
      }

      const rawRef = await this.storeRawPage(source, sync, items);

      const reviews: NormalizedTrustpilotReview[] = [];
      for (const raw of items) {
        const normalized = normalizeTrustpilotReviewItem(raw);
        if (normalized.kind !== 'review') {
          sync.counts.skipped += 1;
          continue;
        }
        const review = normalized.review;
        // Cursor refresh: keep only strictly-newer reviews. Undated reviews
        // pass through — the idempotent upsert absorbs replays.
        if (
          refreshFloor &&
          review.posted_at &&
          review.posted_at <= refreshFloor
        ) {
          sync.counts.skipped += 1;
          continue;
        }
        reviews.push(review);
        if (
          review.posted_at &&
          (!sync.maxPostedAt || review.posted_at > sync.maxPostedAt)
        ) {
          sync.maxPostedAt = review.posted_at;
        }
      }

      const upserted = await this.upsertReviews(source, reviews, page, rawRef);
      sync.counts.upserted += upserted;
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

  private async upsertReviews(
    source: SourceRow,
    reviews: NormalizedTrustpilotReview[],
    page: TrustpilotPageMeta,
    rawRef: string | null,
  ): Promise<number> {
    if (reviews.length === 0) return 0;

    // Dedupe within the batch (a duplicate in one upsert aborts with
    // "cannot affect row a second time").
    const byExternalId = new Map(
      reviews.map((review) => [review.external_id, review]),
    );
    const deduped = [...byExternalId.values()];

    let written = 0;
    for (let i = 0; i < deduped.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = deduped.slice(i, i + UPSERT_CHUNK_SIZE);
      const externalIds = chunk.map((review) => review.external_id);

      // Pre-read existing rows so a replay never clobbers tags written by the
      // extract pass (tags.insight) — merge, don't overwrite.
      const { data: existingRows, error: existingError } = await this._db
        .from('brand_mentions')
        .select('external_id, tags')
        .eq('organization_id', source.organization_id)
        .eq('brand_profile_id', source.brand_profile_id)
        .eq('platform', 'trustpilot')
        .in('external_id', externalIds);
      if (existingError) throw existingError;
      const existingTags = new Map(
        (existingRows ?? []).map((row) => [
          String(row.external_id),
          (row.tags as MentionTags | null) ?? {},
        ]),
      );

      const buildRow = (review: NormalizedTrustpilotReview) => ({
        organization_id: source.organization_id,
        brand_profile_id: source.brand_profile_id,
        source_id: source.id,
        platform: 'trustpilot',
        external_id: review.external_id,
        data_type: 'review',
        scope: 'brand',
        url: review.url ?? page.url,
        subreddit: null,
        author_ref: review.author_ref,
        title: review.title,
        body: review.body,
        posted_at: review.posted_at,
        // The founder confirmed the page — every review is on their own
        // business unit by construction; no relevance gate.
        relevance: 'not_required',
        rating: review.rating,
        raw_ref: rawRef,
        tags: {
          ...existingTags.get(review.external_id),
          trustpilot: {
            verified: review.verified,
            ...(review.country ? { country: review.country } : {}),
            ...(review.company_reply_text
              ? { companyReplyText: review.company_reply_text }
              : {}),
            ...(review.company_reply_at
              ? { companyReplyAt: review.company_reply_at }
              : {}),
            likes: review.likes,
          },
        },
      });

      // Fully text-empty reviews (no title AND no body) store
      // extraction-skipped — their stars still count toward aggregates but
      // they never reach the LLM. A title-only review IS extractable (the
      // shared extractor joins [title, body]). Two upserts because bulk rows
      // must share one key set, and text rows OMIT the column so replays never
      // reset a decided done/skipped back to pending.
      const withText = chunk.filter((review) => review.title || review.body);
      const emptyText = chunk.filter((review) => !review.title && !review.body);

      if (withText.length > 0) {
        const { error } = await this._db
          .from('brand_mentions')
          .upsert(withText.map(buildRow), {
            onConflict: 'brand_profile_id,platform,external_id',
          });
        if (error) throw error;
        written += withText.length;
      }
      if (emptyText.length > 0) {
        const { error } = await this._db
          .from('brand_mentions')
          .upsert(
            emptyText.map((review) => ({
              ...buildRow(review),
              extraction_status: 'skipped',
            })),
            { onConflict: 'brand_profile_id,platform,external_id' },
          );
        if (error) throw error;
        written += emptyText.length;
      }
    }
    return written;
  }

  /** Best-effort raw page archive (Layer-2 key convention). */
  private async storeRawPage(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    items: unknown[],
  ): Promise<string | null> {
    const key = `brand-presence/${source.organization_id}/${source.brand_profile_id}/${source.id}/trustpilot-${sync.phase}-${sync.startedAt}-page${sync.page}.json`;
    try {
      await r2Service.uploadFile(
        R2_BUCKET,
        key,
        JSON.stringify(items),
        'application/json',
        { source: 'brand-presence-trustpilot' },
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
   * and hand the new reviews to the extract pass (they're not_required —
   * relevance never touches them, so this is their pipeline entry). */
  /** `currentJobId` is load-bearing: when nothing is left to extract this job
   * may be the LAST of the profile's pipeline, so it owns the final
   * theme-rebuild drain check (which must exclude its own processing row). */
  private async finalize(
    source: SourceRow,
    meta: SourceMeta,
    tp: TrustpilotSourceMeta,
    sync: SourceSyncCheckpoint,
    currentJobId: string,
    label: string,
  ): Promise<void> {
    const zeroItems =
      sync.counts.upserted === 0 && sync.counts.skipped === 0;
    if (zeroItems) {
      // Zero across all phases — likely actor breakage or a dead/changed page;
      // loud log is the breakage detector (the source still finalizes synced).
      console.warn(`${label}: ZERO items returned across all phases`);
    }
    if (sync.maxPostedAt) {
      meta.cursor = { lastPostedAt: sync.maxPostedAt };
    }
    // Spread the CURRENT trustpilot meta (a refresh run may have updated the
    // page aggregates during ingest), not the value captured at job start.
    meta.trustpilot = {
      ...(meta.trustpilot ?? tp),
      lastRun: {
        finishedAt: new Date().toISOString(),
        upserted: sync.counts.upserted,
        skipped: sync.counts.skipped,
        zeroItems,
      },
    };
    delete meta.sync;
    delete meta.lastError;
    await this.persistSource(source, meta, {
      status: 'synced',
      last_synced_at: new Date().toISOString(),
    });

    const { extractIds } = await enqueueExtractOrDrainCluster(this._db, {
      organizationId: source.organization_id,
      brandProfileId: source.brand_profile_id,
      excludeJobId: currentJobId,
    });

    console.log(
      `${label}: ingested ${sync.counts.upserted} reviews (${sync.counts.skipped} skipped) -> ${extractIds.length} queued for extraction`,
    );
  }

  private buildScopeKey(
    url: string,
    domain: string,
    refresh: boolean,
  ): string {
    const { trustpilot } = BRAND_PRESENCE_CONFIG;
    return createHash('sha256')
      .update(
        JSON.stringify({
          url,
          domain,
          refresh,
          negativeBackfillMaxItems: trustpilot.negativeBackfillMaxItems,
          backfillMaxItems: trustpilot.backfillMaxItems,
          refreshMaxItems: trustpilot.refreshMaxItems,
        }),
      )
      .digest('hex');
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

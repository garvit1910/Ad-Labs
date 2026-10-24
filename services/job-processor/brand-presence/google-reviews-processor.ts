import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type {
  MentionTags,
  SourceMeta,
  SourceSyncCheckpoint,
} from '@/lib/brand-presence/types';
import {
  buildReviewsInput,
  type GoogleReviewsPhase,
} from '@/services/brand-presence/google-maps-actor-input';
import {
  GoogleMapsApifyProvider,
  GoogleMapsProviderError,
} from '@/services/brand-presence/google-maps-apify-provider';
import {
  normalizeGoogleReviewItem,
  type NormalizedGoogleReview,
} from '@/services/brand-presence/google-maps-normalizer';
import { r2Service } from '@/services/r2-service';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import { enqueueExtractOrDrainCluster } from './queue';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceGoogleReviewsPayloadSchema } from './types';

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
 * brand_presence_google_reviews — ONE JOB PER PLACE (one place per source
 * row). Runs the compass reviews actor for the founder-confirmed listing:
 * backfill_low (lowestRanking — bad reviews are the signal the cap must not
 * truncate away), then a smaller topup_high (highestRanking) run when the
 * place has more reviews than the cap, so "what people love" isn't starved.
 * Refresh runs are a single newest-first pass bounded by reviewsStartDate =
 * the posted_at cursor. Raw pages archive to R2; normalized reviews upsert
 * into brand_mentions with platform='google_maps', data_type='review',
 * scope='brand', relevance='not_required' — the founder confirmed their own
 * listing, so there is no relevance gate. Star-only reviews (no text) are
 * stored extraction-skipped: their stars count toward aggregates but they
 * never reach the LLM.
 *
 * Crash-resume state lives in source.meta.sync (same contract as the Reddit
 * scrape checkpoint: persist runId/datasetId immediately after start, resume
 * by scopeKey, page the dataset by offset). The posted_at cursor commits to
 * source.meta.cursor.lastPostedAt at finalize (Reddit convention).
 */
export class BrandPresenceGoogleReviewsProcessor {
  private providerInstance: GoogleMapsApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: GoogleMapsApifyProvider,
  ) {
    this.providerInstance = provider ?? null;
  }

  private get provider(): GoogleMapsApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new GoogleMapsApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceGoogleReviewsPayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, sourceId, refresh } = payload;
    const label = `[BrandPresence] GoogleReviews ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source || source.source_type !== 'google_maps_reviews') {
      console.log(`${label}: source missing, skipping`);
      return;
    }
    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const place = meta.place;
    if (!place?.confirmedAt) {
      // The founder gate — never scrape an unconfirmed listing.
      console.log(`${label}: place not confirmed, skipping`);
      return;
    }

    // The refresh floor is the cursor as of job start (maxPostedAt advances
    // during ingest). Belt-and-braces on top of the actor's day-granular
    // reviewsStartDate filter.
    const refreshFloor = refresh ? (meta.cursor?.lastPostedAt ?? null) : null;

    const scopeKey = this.buildScopeKey(place.url, place.placeId, refresh);
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
        phase: refresh ? 'refresh' : 'backfill_low',
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
            url: place.url,
            phase: sync.phase as GoogleReviewsPhase,
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
          throw new GoogleMapsProviderError(
            `Google Maps reviews run failed (phase=${sync.phase}${outcome.wedged ? ', wedged' : ''})`,
            { retryable: outcome.retryable },
          );
        }

        await this.ingestDataset(source, sync, meta, refreshFloor, {
          signal,
          timeoutTracker,
          label,
        });

        // Backfill done → the smaller highestRanking top-up, but only when
        // the cap actually truncated the review pool (never on refresh).
        const { backfillMaxReviews } = BRAND_PRESENCE_CONFIG.google;
        if (
          sync.phase === 'backfill_low' &&
          (place.reviewsCount ?? 0) > backfillMaxReviews
        ) {
          sync.phase = 'topup_high';
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

      await this.finalize(source, meta, sync, String(job.id), label);
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

  private async ingestDataset(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    meta: SourceMeta,
    refreshFloor: string | null,
    opts: {
      signal: AbortSignal;
      timeoutTracker?: FunctionTimeoutTracker;
      label: string;
    },
  ): Promise<void> {
    const { datasetPageSize } = BRAND_PRESENCE_CONFIG;
    if (!sync.datasetId) {
      throw new GoogleMapsProviderError(
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

      const rawRef = await this.storeRawPage(source, sync, items);

      const reviews: NormalizedGoogleReview[] = [];
      for (const raw of items) {
        const normalized = normalizeGoogleReviewItem(raw);
        if (normalized.kind !== 'review') {
          sync.counts.skipped += 1;
          console.log(`${opts.label}: skipping item (${normalized.reason})`);
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

      const upserted = await this.upsertReviews(source, reviews, rawRef);
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
    reviews: NormalizedGoogleReview[],
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

      // Pre-read existing rows so a replay never clobbers tags written by
      // the extract pass (tags.insight) — merge, don't overwrite.
      const { data: existingRows, error: existingError } = await this._db
        .from('brand_mentions')
        .select('external_id, tags')
        .eq('organization_id', source.organization_id)
        .eq('brand_profile_id', source.brand_profile_id)
        .eq('platform', 'google_maps')
        .in('external_id', externalIds);
      if (existingError) throw existingError;
      const existingTags = new Map(
        (existingRows ?? []).map((row) => [
          String(row.external_id),
          (row.tags as MentionTags | null) ?? {},
        ]),
      );

      const buildRow = (review: NormalizedGoogleReview) => ({
        organization_id: source.organization_id,
        brand_profile_id: source.brand_profile_id,
        source_id: source.id,
        platform: 'google_maps',
        external_id: review.external_id,
        data_type: 'review',
        scope: 'brand',
        url: review.url,
        subreddit: null,
        author_ref: review.author_ref,
        title: null,
        body: review.body,
        posted_at: review.posted_at,
        // The founder confirmed the listing — every review is on their own
        // place by construction; no relevance gate.
        relevance: 'not_required',
        rating: review.rating,
        raw_ref: rawRef,
        tags: {
          ...existingTags.get(review.external_id),
          google: {
            placeId: review.place_id,
            likesCount: review.likes,
            ...(review.owner_response_text
              ? { ownerResponseText: review.owner_response_text }
              : {}),
            ...(review.owner_response_at
              ? { ownerResponseAt: review.owner_response_at }
              : {}),
            ...(review.original_text
              ? { originalText: review.original_text }
              : {}),
            ...(review.review_image_count
              ? { reviewImageCount: review.review_image_count }
              : {}),
          },
        },
      });

      // Star-only reviews store extraction-skipped (their stars still count
      // toward aggregates but they never reach the LLM). Two upserts because
      // bulk rows must share one key set — and text rows OMIT the column so
      // replays never reset a decided done/skipped back to pending.
      const withBody = chunk.filter((review) => review.body);
      const emptyBody = chunk.filter((review) => !review.body);

      if (withBody.length > 0) {
        const { error } = await this._db
          .from('brand_mentions')
          .upsert(withBody.map(buildRow), {
            onConflict: 'brand_profile_id,platform,external_id',
          });
        if (error) throw error;
        written += withBody.length;
      }
      if (emptyBody.length > 0) {
        const { error } = await this._db
          .from('brand_mentions')
          .upsert(
            emptyBody.map((review) => ({
              ...buildRow(review),
              extraction_status: 'skipped',
            })),
            { onConflict: 'brand_profile_id,platform,external_id' },
          );
        if (error) throw error;
        written += emptyBody.length;
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
    const key = `brand-presence/${source.organization_id}/${source.brand_profile_id}/${source.id}/google-maps-${sync.startedAt}-page${sync.page}.json`;
    try {
      await r2Service.uploadFile(
        R2_BUCKET,
        key,
        JSON.stringify(items),
        'application/json',
        { source: 'brand-presence-google-maps' },
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

  /** Commit the cursor, clear the checkpoint, mark synced, and hand the new
   * reviews to the extract pass (they're not_required — relevance never
   * touches them, so this is their pipeline entry). When nothing is left to
   * extract this job may be the LAST one of the profile's pipeline, so it
   * owns the final theme-rebuild drain check — hence `currentJobId`. */
  private async finalize(
    source: SourceRow,
    meta: SourceMeta,
    sync: SourceSyncCheckpoint,
    currentJobId: string,
    label: string,
  ): Promise<void> {
    if (sync.counts.upserted === 0 && sync.counts.skipped === 0) {
      // Zero-item run — likely actor breakage or a dead/changed URL; loud log
      // is the breakage detector (the source still finalizes as synced).
      console.warn(`${label}: ZERO items returned across all phases`);
    }
    if (sync.maxPostedAt) {
      meta.cursor = { lastPostedAt: sync.maxPostedAt };
    }
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
    placeId: string | null,
    refresh: boolean,
  ): string {
    const { google } = BRAND_PRESENCE_CONFIG;
    return createHash('sha256')
      .update(
        JSON.stringify({
          url,
          placeId,
          refresh,
          backfillMaxReviews: google.backfillMaxReviews,
          topUpRatio: google.topUpRatio,
          refreshMaxReviews: google.refreshMaxReviews,
          language: google.language,
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

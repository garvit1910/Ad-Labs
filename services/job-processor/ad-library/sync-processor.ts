import type { SupabaseClient } from '@supabase/supabase-js';
import { getAdLibraryProvider } from '@/services/ad-library';
import type { AdLibraryQuery } from '@/services/ad-library/types';
import { getApifyMaxAds } from '@/services/ad-library/apify-config';
import type { FunctionTimeoutTracker } from '../function-timeout';
import type { Job } from '../types';
import { maybeEnqueueMarketAfterAdlibSync } from '@/services/job-processor/brand-object/queue';
import {
  enqueueEmbedBatches,
  enqueueLabelBatches,
  enqueueRehostBatches,
} from './queue';
import { computeAdlibCadence } from './cadence';
import { adlibSyncCompetitorPayloadSchema } from './types';
import {
  INDUSTRY_ADS_PER_SYNC,
  INDUSTRY_CATALOG_ORG_ID,
} from '@/lib/brand-identity/industries';
import {
  attemptPageIdResolution,
  countNewAds,
  findAdIdsNeedingRehost,
  findUnembeddedAdIds,
  findUnlabeledAdIds,
  persistIndustryClassification,
  persistLandingDomainScore,
  purgeMockRows,
  shouldAttemptPageIdResolution,
  syncViaPaging,
  syncViaRunLifecycle,
  type CompetitorRow,
} from './sync';

interface FinalizeSyncContext {
  organizationId: string;
  competitorId: string;
  syncIso: string;
  totalAds: number;
  highVolumeThreshold: number;
  signal: AbortSignal;
}

/**
 * adlib_sync_competitor — pulls a tracked competitor's ads from the Ad
 * Library provider, upserts them into library_ads (idempotent on
 * (organization_id, platform, external_ad_id)), stores raw pages to R2, and
 * enqueues label batches for any still-unlabeled ads.
 *
 * The heavy lifting lives in ./sync/ (fetch paths, persistence, enrichment);
 * this class owns job orchestration: payload → competitor gate → fetch-path
 * selection → finalize.
 */
export class AdLibrarySyncProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker
  ): Promise<void> {
    const payload = adlibSyncCompetitorPayloadSchema.parse(job.payload);
    const { organizationId, competitorId } = payload;

    const { data: competitor, error: competitorError } = await this._db
      .from('tracked_competitors')
      .select(
        'id, organization_id, platform, name, keyword, country, page_ref, meta_page_id, google_advertiser_id, google_advertiser_name, status, sync_run_id, sync_run_started_at, industry, last_synced_at, scores'
      )
      .eq('id', competitorId)
      .eq('organization_id', organizationId)
      .maybeSingle<CompetitorRow>();
    if (competitorError) throw competitorError;
    if (!competitor) {
      console.log(
        `[AdLibSync] Competitor ${competitorId} not found for org ${organizationId}, skipping`
      );
      return;
    }
    if (competitor.status !== 'active') {
      console.log(`[AdLibSync] Competitor ${competitorId} is paused, skipping`);
      return;
    }

    // Google tracks by AR advertiser id; Meta tracks by keyword, a page handle
    // (preferred for page tracking), or a numeric Meta Page ID. Providers
    // consume whichever they support.
    const isGoogle = competitor.platform === 'google';
    if (isGoogle ? !competitor.google_advertiser_id : !(
      competitor.keyword || competitor.page_ref || competitor.meta_page_id
    )) {
      console.log(
        `[AdLibSync] Competitor ${competitorId} (${competitor.platform}) has no tracking target, skipping`
      );
      return;
    }
    const query: AdLibraryQuery = isGoogle
      ? { advertiserId: competitor.google_advertiser_id ?? undefined }
      : {
          keyword: competitor.keyword ?? undefined,
          pageHandle: competitor.page_ref ?? undefined,
          pageId: competitor.meta_page_id ?? undefined,
          country: competitor.country ?? undefined,
        };

    const provider = getAdLibraryProvider(isGoogle ? 'google' : 'meta');
    const syncIso = new Date().toISOString();
    // Industry catalog seeds cache a fixed ~100/industry; real competitors use
    // the provider's own default ceiling (undefined ⇒ getApifyMaxAds()). A
    // catalog seed is identified by its OWNING ORG, never by `industry` being
    // set: user-tracked competitors carry an auto-applied industry
    // classification too, and capping them at 100 impression-sorted active ads
    // dropped long-running winners out of the 32-day active window.
    const adLimit =
      competitor.organization_id === INDUSTRY_CATALOG_ORG_ID
        ? INDUSTRY_ADS_PER_SYNC
        : undefined;

    // Cost lever (Meta only — the Google actor is rental-priced, not per-result):
    // the FIRST sync pulls 'all' (backfill the full history, including
    // already-stopped proven winners); every later sync pulls only 'active' ads
    // so the per-result-billed actor stops re-charging for dead ads we already
    // hold. `last_synced_at IS NULL` is the first-sync signal (it's stamped on
    // every completed sync, including cache-served ones).
    const activeStatus: 'all' | 'active' | undefined = isGoogle
      ? undefined
      : competitor.last_synced_at
        ? 'active'
        : 'all';

    const ctx = {
      db: this._db,
      provider,
      competitor,
      query,
      organizationId,
      competitorId,
      syncIso,
      signal,
      timeoutTracker,
      adLimit,
      activeStatus,
    };

    // Providers that expose a run lifecycle (Apify) take ~1-3 min; drive them
    // via a cron-resumable start/poll path keyed off a persisted run id.
    // Instant providers (mock/meta) keep the simple paging path.
    const totalAds =
      provider.startRun && provider.pollRun
        ? await syncViaRunLifecycle(ctx)
        : await syncViaPaging(ctx);

    // Switching a competitor from the mock provider to a real one leaves stale
    // mock rows behind (different external_ad_id space). Purge them so the
    // library shows only real ads under a real provider.
    if (provider.name !== 'mock') {
      await purgeMockRows(this._db, organizationId, competitorId);
    }

    // Private/region-gated Facebook pages defeat the raw page-URL scrape (the
    // actor sees the login wall → permanent zero, and the normal from-the-ads
    // meta_page_id backfill never gets input). Resolve the numeric Page ID
    // from a small keyword scrape of the handle, then re-fetch in this same
    // job via the privacy-immune view_all_page_id URL.
    let finalTotalAds = totalAds;
    if (totalAds === 0 && shouldAttemptPageIdResolution(competitor, provider)) {
      const resolvedPageId = await attemptPageIdResolution({
        db: this._db,
        provider,
        competitor,
        signal,
        timeoutTracker,
      });
      if (resolvedPageId) {
        // Keep pageHandle in the query so the cache identity matches what
        // future syncs (which re-read the now-backfilled row) will compute;
        // the provider prefers pageId, so the handle never drives the URL.
        const retryQuery: AdLibraryQuery = {
          pageHandle: competitor.page_ref ?? undefined,
          pageId: resolvedPageId,
          country: competitor.country ?? undefined,
        };
        // 'all': this competitor has no corpus yet, so the retry IS its first
        // real backfill even though earlier zero-ad syncs stamped
        // last_synced_at. A mid-run pause resumes via the competitor's run
        // checkpoint like any other lifecycle run.
        const retryCtx = {
          ...ctx,
          // Null the in-memory run checkpoint: the row's checkpoint was
          // already cleared when the main (zero-ad) run finished, and a stale
          // value here would make the retry "resume" that dead run instead of
          // starting the page-id one.
          competitor: {
            ...competitor,
            meta_page_id: resolvedPageId,
            sync_run_id: null,
            sync_run_started_at: null,
          },
          query: retryQuery,
          activeStatus: 'all' as const,
        };
        finalTotalAds =
          provider.startRun && provider.pollRun
            ? await syncViaRunLifecycle(retryCtx)
            : await syncViaPaging(retryCtx);
      }
    }

    await this.finalizeSync({
      organizationId,
      competitorId,
      syncIso,
      totalAds: finalTotalAds,
      highVolumeThreshold: adLimit ?? getApifyMaxAds(),
      signal,
    });
  }

  /** Stamp last_synced_at and enqueue label batches for any unlabeled ads. */
  private async finalizeSync({
    organizationId,
    competitorId,
    syncIso,
    totalAds,
    highVolumeThreshold,
    signal,
  }: FinalizeSyncContext): Promise<void> {
    // Classify the brand FIRST (from its name + a sample of just-synced ads) and
    // auto-apply `industry`, so the label batches enqueued below are processed
    // with the correct industry angle vocabulary. Runs for every provider path.
    await persistIndustryClassification(
      this._db,
      organizationId,
      competitorId,
      syncIso,
      signal
    );

    // Dominant landing domain → scores.landingDomain, the cross-platform
    // brand-pairing key. Runs before the cadence read below so its merge-write
    // is included in the freshest scores snapshot.
    await persistLandingDomainScore(
      this._db,
      organizationId,
      competitorId,
      syncIso
    );

    // Monthly cadence diagnostics: measure how many ads this sync newly
    // discovered and record the next fixed 30-day due date. Merge into the
    // freshest `scores` (persistIndustryClassification above may have just
    // written it) so no sibling key is stomped.
    const newAdCount = await countNewAds(
      this._db,
      organizationId,
      competitorId,
      syncIso
    );
    const { data: currentScoresRow } = await this._db
      .from('tracked_competitors')
      .select('scores')
      .eq('id', competitorId)
      .maybeSingle<{ scores: Record<string, unknown> | null }>();
    const scores = (currentScoresRow?.scores ?? {}) as Record<string, unknown>;
    const adlibCadence = computeAdlibCadence(
      scores.adlibCadence,
      newAdCount,
      syncIso,
      {
        totalAds,
        highVolumeThreshold,
      }
    );

    const { error: syncStampError } = await this._db
      .from('tracked_competitors')
      .update({
        last_synced_at: syncIso,
        updated_at: syncIso,
        scores: { ...scores, adlibCadence },
      })
      .eq('id', competitorId);
    if (syncStampError) throw syncStampError;

    const newAdIds = await findUnlabeledAdIds(
      this._db,
      organizationId,
      competitorId
    );
    if (newAdIds.length > 0) {
      const { jobIds, deduped } = await enqueueLabelBatches(
        this._db,
        organizationId,
        newAdIds
      );
      console.log(
        `[AdLibSync] Competitor ${competitorId}: ${totalAds} ads synced, ${newAdIds.length} unlabeled → ${jobIds.length} label batches (${deduped} deduped)`
      );
    } else {
      console.log(
        `[AdLibSync] Competitor ${competitorId}: ${totalAds} ads synced, all labeled`
      );
    }

    // Embeddings power the replication signal and are independent of labelling,
    // so enqueue over ads missing an ad_embeddings row (also backfills ads that
    // predate embeddings on a later sync).
    const unembeddedAdIds = await findUnembeddedAdIds(
      this._db,
      organizationId,
      competitorId
    );
    if (unembeddedAdIds.length > 0) {
      const { jobIds, deduped } = await enqueueEmbedBatches(
        this._db,
        organizationId,
        unembeddedAdIds
      );
      console.log(
        `[AdLibSync] Competitor ${competitorId}: ${unembeddedAdIds.length} unembedded → ${jobIds.length} embed batches (${deduped} deduped)`
      );
    }

    // Rehosting is best-effort: the sync's durable source rows and other
    // enrichment stages must still complete if queue inspection/insertion has
    // a transient failure. A later sync (or the manual backfill) retries it.
    try {
      const rehostAdIds = await findAdIdsNeedingRehost(
        this._db,
        organizationId,
        competitorId
      );
      if (rehostAdIds.length > 0) {
        const { jobIds, deduped } = await enqueueRehostBatches(
          this._db,
          organizationId,
          rehostAdIds
        );
        console.log(
          `[AdLibSync] Competitor ${competitorId}: ${rehostAdIds.length} need media rehost → ${jobIds.length} rehost batches (${deduped} deduped)`
        );
      }
    } catch (error) {
      console.warn(
        `[AdLibSync] Competitor ${competitorId}: failed to enqueue media rehost batches`,
        error
      );
    }

    // Layer-3 hook (fail-soft, opt-in): the winner set may have changed even
    // with zero new ads (winner membership is longevity-gated), so nudge a
    // market re-derive for opted-in brands scoped to this competitor. The
    // label-batch drain seam covers freshly-labeled ads; this seam covers
    // already-labeled syncs and pure winner drift.
    try {
      await maybeEnqueueMarketAfterAdlibSync(this._db, {
        organizationId,
        competitorId,
      });
    } catch (error) {
      console.warn(
        `[AdLibSync] Competitor ${competitorId}: market hook failed (non-fatal)`,
        error
      );
    }
  }
}

// Keep the historical import surface: helpers extracted to ./sync stay
// importable from this module (mirrors label-processor.ts / label/).
export * from './sync';

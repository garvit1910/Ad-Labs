import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AdLibraryProviderError,
  type AdLibraryProvider,
  type AdLibraryQuery,
  type NormalizedAd,
} from '@/services/ad-library/types';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../../function-timeout';
import { MAX_RUN_WALL_MS, type CompetitorRow } from './types';
import { backfillIdentity, persistBrandTypeSuggestion } from './enrichment';
import {
  clearSyncRunCheckpoint,
  setSyncRunCheckpoint,
  storeRawPayload,
  upsertAds,
} from './persistence';

const MAX_PAGES = 10;
/** Poll the Apify run this often while it is still running. */
const POLL_INTERVAL_MS = 5_000;

/** Everything a fetch path needs, resolved once by `process()`. */
export interface SyncFetchContext {
  db: SupabaseClient;
  provider: AdLibraryProvider;
  competitor: CompetitorRow;
  query: AdLibraryQuery;
  organizationId: string;
  competitorId: string;
  syncIso: string;
  signal: AbortSignal;
  timeoutTracker?: FunctionTimeoutTracker;
  adLimit?: number;
  activeStatus?: 'all' | 'active';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Ad library sync aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Mock/Meta: instant provider, paginate and upsert per page. */
export async function syncViaPaging(ctx: SyncFetchContext): Promise<number> {
  const {
    db,
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
  } = ctx;
  let cursor: string | undefined;
  const allAds: NormalizedAd[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal.aborted) throw new Error('Ad library sync aborted');
    if (timeoutTracker?.shouldStop()) {
      throw new FunctionTimeoutError(
        'Function timeout - will resume on next cron'
      );
    }

    const result = await provider.fetchAds(query, {
      after: cursor,
      signal,
      limit: adLimit,
      activeStatus,
    });
    const rawRef = await storeRawPayload(
      organizationId,
      competitorId,
      syncIso,
      page,
      result.rawPayload
    );
    if (result.ads.length > 0) {
      await upsertAds(
        db,
        result.ads,
        organizationId,
        competitorId,
        competitor.platform,
        syncIso,
        rawRef
      );
      allAds.push(...result.ads);
    }
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return allAds.length;
}

/**
 * Apify: start the run (or resume polling an in-flight one), poll within the
 * function budget, and upsert once it succeeds. The run id is checkpointed on
 * the competitor so a cron resume polls the existing run instead of starting
 * a new (billable) one. Keys off run STATUS, never an interim count.
 */
export async function syncViaRunLifecycle(ctx: SyncFetchContext): Promise<number> {
  const {
    db,
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
  } = ctx;
  let runId = competitor.sync_run_id;
  // Staleness is state-based: a resumed run keeps polling as long as the
  // provider reports it alive, no matter how long it takes. The wall-clock
  // ceiling below only catches genuinely wedged runs. (An age-based abandon
  // here used to restart any run slower than its threshold forever — each
  // orphaned Apify run kept running and billing.)
  let runStartedAt = competitor.sync_run_started_at
    ? new Date(competitor.sync_run_started_at).getTime()
    : Date.now();

  if (runId) {
    console.log(`[AdLibSync] Competitor ${competitorId} resuming run ${runId}`);
  } else {
    runId = await provider.startRun!(query, {
      signal,
      limit: adLimit,
      activeStatus,
    });
    runStartedAt = Date.now();
    await setSyncRunCheckpoint(db, competitorId, runId, syncIso);
    console.log(`[AdLibSync] Competitor ${competitorId} started run ${runId}`);
  }

  for (;;) {
    if (signal.aborted) throw new Error('Ad library sync aborted');

    const status = await provider.pollRun!(runId);

    if (status.state === 'succeeded') {
      const result = status.result ?? { ads: [], rawPayload: null };
      const rawRef = await storeRawPayload(
        organizationId,
        competitorId,
        syncIso,
        0,
        result.rawPayload
      );
      if (result.ads.length > 0) {
        await upsertAds(
          db,
          result.ads,
          organizationId,
          competitorId,
          competitor.platform,
          syncIso,
          rawRef
        );
        // Resolve the advertiser identity from the scraped ads and backfill
        // the competitor (a "@uprootclean" row becomes "Uproot Clean" with its
        // numeric id; a Google AR row gets its advertiser display name).
        await backfillIdentity(db, competitor, result.ads);
        // Advisory only: suggest an archetype into scores for human review.
        // Never auto-commits brand_type.
        await persistBrandTypeSuggestion(db, competitor, result.ads, syncIso);
        // Industry classification is centralized in finalizeSync (runs for
        // every provider path, before label batches are enqueued).
      }
      await clearSyncRunCheckpoint(db, competitorId);
      return result.ads.length;
    }

    if (status.state === 'failed') {
      await clearSyncRunCheckpoint(db, competitorId);
      throw new AdLibraryProviderError('Apify run failed', {
        retryable: status.retryable ?? true,
      });
    }

    // Still running past the hard ceiling — a wedged run. Abort it so it
    // stops billing, then fail retryable so job attempts are counted.
    if (Date.now() - runStartedAt > MAX_RUN_WALL_MS) {
      console.warn(
        `[AdLibSync] Competitor ${competitorId} aborting wedged run ${runId}`
      );
      await abortProviderRun(provider, runId);
      await clearSyncRunCheckpoint(db, competitorId);
      throw new AdLibraryProviderError(
        `Apify run ${runId} exceeded the ${MAX_RUN_WALL_MS / 60_000} min wall-clock ceiling`,
        { retryable: true }
      );
    }

    // Still running — yield to the next cron if we are out of budget.
    if (timeoutTracker?.shouldStop()) {
      throw new FunctionTimeoutError(
        'Function timeout - will resume on next cron'
      );
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
}

/** Best-effort abort of an abandoned provider run so it stops billing. */
async function abortProviderRun(
  provider: AdLibraryProvider,
  runId: string
): Promise<void> {
  if (!provider.abortRun) return;
  try {
    await provider.abortRun(runId);
  } catch (error) {
    console.warn(
      `[AdLibSync] Failed to abort run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

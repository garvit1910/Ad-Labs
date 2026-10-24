import { ApifyClient } from 'apify-client';
import {
  APIFY_AD_LIBRARY_ACTOR_ID,
  buildApifyActorInput,
  createApifyClient,
  getApifyCallTimeoutMs,
  getApifyControlTimeoutMs,
  getApifyMaxAds,
} from './apify-config';
import { withApifyTimeout } from './apify-timeout';
import { normalizeApifyAd, type ApifyAdItem } from './apify-normalizer';
import {
  buildAdLibraryPageUrl,
  buildAdLibrarySearchUrl,
  buildFacebookPageUrl,
} from './apify-url';
import {
  AdLibraryProvider,
  AdLibraryProviderError,
  AdLibraryQuery,
  AdLibraryRunStatus,
  FetchAdsOptions,
  FetchAdsResult,
  NormalizedAd,
} from './types';
import { DEFAULT_AD_LIBRARY_COUNTRY } from '@/lib/brand-identity/countries';

/**
 * Real Ad Library implementation backed by the Apify
 * curious_coder/facebook-ads-library-scraper actor. Selected with
 * AD_LIBRARY_PROVIDER=apify (requires APIFY_TOKEN, server-only).
 *
 * The actor takes a Meta Ad Library *search URL* (built from keyword +
 * country), shows zero results until the run finishes, and runs for ~1-3 min —
 * so we key off run STATUS, never an interim count. This blocking `.call()`
 * path is the dev/synchronous path; Phase 3 adds a cron-resumable start/poll
 * lifecycle for the serverless sync job.
 */
export class ApifyAdLibraryProvider implements AdLibraryProvider {
  readonly name = 'apify' as const;
  private readonly client: ApifyClient;

  constructor(client?: ApifyClient) {
    this.client = client ?? createApifyClient();
  }

  async fetchAds(
    query: AdLibraryQuery,
    opts: FetchAdsOptions = {}
  ): Promise<FetchAdsResult> {
    // The actor returns the full result set in one run; there is no cursor, so
    // a second page request (after set) is a no-op.
    if (opts.after) {
      return { ads: [], rawPayload: { apify: true, page: 'after' } };
    }

    const input = this.buildInput(query, opts);
    let run;
    try {
      run = await withApifyTimeout(
        'run (call)',
        this.client.actor(APIFY_AD_LIBRARY_ACTOR_ID).call(input),
        getApifyCallTimeoutMs()
      );
    } catch (error) {
      throw new AdLibraryProviderError(
        `Apify run failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true }
      );
    }

    // Key off run STATUS — an interim/zero count is never treated as failure.
    if (run.status !== 'SUCCEEDED') {
      throw new AdLibraryProviderError(
        `Apify run did not succeed (status=${run.status})`,
        { retryable: run.status !== 'ABORTED' }
      );
    }

    return this.collectResult(run.id, run.defaultDatasetId);
  }

  /**
   * Kicks off the actor without waiting and returns the Apify run id. Persisted
   * by the sync job so a cron resume polls this run instead of starting a new
   * (billable) one.
   */
  async startRun(
    query: AdLibraryQuery,
    opts: FetchAdsOptions = {}
  ): Promise<string> {
    const input = this.buildInput(query, opts);
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client.actor(APIFY_AD_LIBRARY_ACTOR_ID).start(input),
        getApifyControlTimeoutMs()
      );
      return run.id;
    } catch (error) {
      throw new AdLibraryProviderError(
        `Apify run failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true }
      );
    }
  }

  /** Reports run status; keyed off Apify STATUS, never an interim count. */
  async pollRun(providerRunId: string): Promise<AdLibraryRunStatus> {
    const run = await withApifyTimeout(
      'run poll (get)',
      this.client.run(providerRunId).get(),
      getApifyControlTimeoutMs()
    );
    if (!run) {
      return { state: 'failed', retryable: false };
    }
    switch (run.status) {
      case 'SUCCEEDED':
        return {
          state: 'succeeded',
          result: await this.collectResult(run.id, run.defaultDatasetId),
        };
      case 'READY':
      case 'RUNNING':
        return { state: 'running' };
      default:
        // FAILED / TIMED-OUT / ABORTED / ABORTING
        return { state: 'failed', retryable: run.status !== 'ABORTED' };
    }
  }

  /** Aborts an abandoned run so it stops accruing Apify usage. */
  async abortRun(providerRunId: string): Promise<void> {
    await this.client.run(providerRunId).abort();
  }

  private buildInput(query: AdLibraryQuery, opts: FetchAdsOptions) {
    const keyword = query.keyword?.trim();
    const pageHandle = query.pageHandle?.trim();
    const pageId = query.pageId?.trim();
    const country = query.country ?? DEFAULT_AD_LIBRARY_COUNTRY;
    // Keyword search; else a numeric Page ID (Ad Library view_all_page_id URL —
    // privacy-immune: the Ad Library indexes ads by Page ID even when the
    // Facebook page itself is restricted); else a page handle (raw page URL —
    // fails for private/region-gated pages, see sync/page-id-resolution.ts).
    const searchUrl = keyword
      ? buildAdLibrarySearchUrl(keyword, country)
      : pageId
        ? buildAdLibraryPageUrl(pageId, country)
        : pageHandle
          ? buildFacebookPageUrl(pageHandle)
          : null;
    if (!searchUrl) {
      throw new AdLibraryProviderError(
        'ApifyAdLibraryProvider requires a keyword, page handle, or Meta Page ID',
        { retryable: false }
      );
    }
    const count = opts.limit ?? getApifyMaxAds();
    return buildApifyActorInput(searchUrl, count, opts.activeStatus ?? 'all');
  }

  private async collectResult(
    runId: string,
    datasetId: string
  ): Promise<FetchAdsResult> {
    const { items } = await withApifyTimeout(
      'dataset listItems',
      this.client.dataset(datasetId).listItems(),
      getApifyControlTimeoutMs()
    );
    const ads = (items as ApifyAdItem[])
      .map(normalizeApifyAd)
      .filter((ad): ad is NormalizedAd => ad !== null);
    // The actor returns a single error sentinel (e.g. "Page is private",
    // "Ads not found") when a page/search yields nothing scrapeable. Surface it
    // so an empty result is explainable rather than a silent zero.
    if (ads.length === 0) {
      const sentinel = (items as Array<{ error?: string }>).find((i) => i.error);
      if (sentinel?.error) {
        console.warn(`[Apify] run ${runId} returned no ads: ${sentinel.error}`);
      }
    }
    return { ads, rawPayload: { runId, items } };
  }
}

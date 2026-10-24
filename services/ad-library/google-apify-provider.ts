import { ApifyClient } from 'apify-client';
import {
  APIFY_GOOGLE_ADS_ACTOR_ID,
  buildGoogleActorInput,
  buildGoogleAdvertiserUrl,
  createApifyClient,
  getApifyCallTimeoutMs,
  getApifyControlTimeoutMs,
  getApifyMaxAds,
} from './apify-config';
import { withApifyTimeout } from './apify-timeout';
import { normalizeGoogleAd, type GoogleAdItem } from './google-normalizer';
import {
  AdLibraryProvider,
  AdLibraryProviderError,
  AdLibraryQuery,
  AdLibraryRunStatus,
  FetchAdsOptions,
  FetchAdsResult,
  NormalizedAd,
} from './types';

/**
 * Real Google Ads implementation backed by the Apify
 * silva95gustavo/google-ads-scraper actor (Google Ads Transparency Center).
 * Selected with GOOGLE_AD_LIBRARY_PROVIDER=apify (requires APIFY_TOKEN and an
 * activated actor rental, server-only).
 *
 * Mirrors the Meta Apify provider: the actor takes a Transparency Center
 * advertiser URL (built from the AR id), runs for ~1-3 min, and is driven by the
 * cron-resumable start/poll lifecycle. Keys off run STATUS, never an interim
 * count.
 */
export class GoogleApifyAdLibraryProvider implements AdLibraryProvider {
  readonly name = 'google' as const;
  private readonly client: ApifyClient;

  constructor(client?: ApifyClient) {
    this.client = client ?? createApifyClient();
  }

  async fetchAds(
    query: AdLibraryQuery,
    opts: FetchAdsOptions = {}
  ): Promise<FetchAdsResult> {
    // The actor returns the full result set in one run; there is no cursor.
    if (opts.after) {
      return { ads: [], rawPayload: { google: true, page: 'after' } };
    }

    const input = this.buildInput(query, opts);
    let run;
    try {
      run = await withApifyTimeout(
        'run (call)',
        this.client.actor(APIFY_GOOGLE_ADS_ACTOR_ID).call(input),
        getApifyCallTimeoutMs()
      );
    } catch (error) {
      throw new AdLibraryProviderError(
        `Google Apify run failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true }
      );
    }

    if (run.status !== 'SUCCEEDED') {
      throw new AdLibraryProviderError(
        `Google Apify run did not succeed (status=${run.status})`,
        { retryable: run.status !== 'ABORTED' }
      );
    }

    return this.collectResult(run.id, run.defaultDatasetId);
  }

  /** Kicks off the actor without waiting; returns the Apify run id. */
  async startRun(
    query: AdLibraryQuery,
    opts: FetchAdsOptions = {}
  ): Promise<string> {
    const input = this.buildInput(query, opts);
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client.actor(APIFY_GOOGLE_ADS_ACTOR_ID).start(input),
        getApifyControlTimeoutMs()
      );
      return run.id;
    } catch (error) {
      throw new AdLibraryProviderError(
        `Google Apify run failed to start: ${error instanceof Error ? error.message : String(error)}`,
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
    const advertiserId = query.advertiserId?.trim();
    if (!advertiserId) {
      throw new AdLibraryProviderError(
        'GoogleApifyAdLibraryProvider requires a Google AR advertiser id',
        { retryable: false }
      );
    }
    const count = opts.limit ?? getApifyMaxAds();
    return buildGoogleActorInput(buildGoogleAdvertiserUrl(advertiserId), count);
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
    const now = new Date();
    const ads = (items as GoogleAdItem[])
      .map((item) => normalizeGoogleAd(item, { now }))
      .filter((ad): ad is NormalizedAd => ad !== null);
    if (ads.length === 0) {
      const sentinel = (items as Array<{ error?: string }>).find((i) => i.error);
      if (sentinel?.error) {
        console.warn(
          `[GoogleApify] run ${runId} returned no ads: ${sentinel.error}`
        );
      }
    }
    return { ads, rawPayload: { runId, items } };
  }
}

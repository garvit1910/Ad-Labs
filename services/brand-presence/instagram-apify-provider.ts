import type { ApifyClient } from 'apify-client';
import {
  createApifyClient,
  getApifyControlTimeoutMs,
} from '@/services/ad-library/apify-config';
import { withApifyTimeout } from '@/services/ad-library/apify-timeout';
import type { InstagramScraperInput } from './instagram-actor-input';

/** apify/instagram-scraper (official, $2.30/1k results) — ONE actor behind
 * every instagram_comments run; the content-type mode lives in the INPUT
 * (details probe / posts + reels enumeration / comments harvest), so a
 * single startRun covers what TikTok needs two actors for. */
export const INSTAGRAM_SCRAPER_ACTOR_ID = 'apify~instagram-scraper';

export class InstagramProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'InstagramProviderError';
    this.retryable = opts.retryable;
  }
}

export interface InstagramRunHandle {
  runId: string;
  datasetId: string;
}

export type InstagramRunStatus =
  | { state: 'running' }
  | { state: 'succeeded' }
  | { state: 'failed'; retryable: boolean };

/**
 * Run-lifecycle harness for the Instagram scraper — a structural twin of the
 * Reddit/TikTok providers (start/poll/abort keyed off run STATUS, never an
 * interim count; paginated dataset reads for mid-dataset resume).
 *
 * Deliberately NOT implemented: the actor's run-sync endpoints (long runs
 * break the HTTP connection) and the runs/last endpoints (racy across
 * concurrent brands) — always address the specific runId/datasetId.
 */
export class InstagramApifyProvider {
  private readonly client: ApifyClient;

  constructor(client?: ApifyClient) {
    this.client = client ?? createApifyClient();
  }

  /**
   * Starts a run in whatever mode the input selects, without waiting, and
   * returns both ids. The caller must persist them immediately — that
   * checkpoint is what makes a crashed or budget-yielded job resume this
   * run instead of starting a new billable one.
   */
  async startRun(input: InstagramScraperInput): Promise<InstagramRunHandle> {
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client.actor(INSTAGRAM_SCRAPER_ACTOR_ID).start(input),
        getApifyControlTimeoutMs(),
      );
      return { runId: run.id, datasetId: run.defaultDatasetId };
    } catch (error) {
      throw new InstagramProviderError(
        `Instagram scraper ${input.resultsType} run failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
  }

  /** Status-keyed poll; a missing run is a non-retryable failure. */
  async pollRun(runId: string): Promise<InstagramRunStatus> {
    const run = await withApifyTimeout(
      'run poll (get)',
      this.client.run(runId).get(),
      getApifyControlTimeoutMs(),
    );
    if (!run) {
      return { state: 'failed', retryable: false };
    }
    switch (run.status) {
      case 'SUCCEEDED':
        return { state: 'succeeded' };
      case 'READY':
      case 'RUNNING':
        return { state: 'running' };
      default:
        // FAILED / TIMED-OUT / ABORTED / ABORTING
        return { state: 'failed', retryable: run.status !== 'ABORTED' };
    }
  }

  /** Aborts an abandoned run so it stops accruing Apify usage. */
  async abortRun(runId: string): Promise<void> {
    await withApifyTimeout(
      'run abort',
      this.client.run(runId).abort(),
      getApifyControlTimeoutMs(),
    );
  }

  /**
   * One page of clean dataset items. Callers loop with a persisted offset;
   * a short page (< limit) means the dataset is exhausted.
   */
  async listDatasetItems(
    datasetId: string,
    offset: number,
    limit: number,
  ): Promise<unknown[]> {
    const { items } = await withApifyTimeout(
      'dataset listItems',
      this.client.dataset(datasetId).listItems({ clean: true, offset, limit }),
      getApifyControlTimeoutMs(),
    );
    return items as unknown[];
  }
}

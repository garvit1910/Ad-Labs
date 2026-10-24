import type { ApifyClient } from 'apify-client';
import {
  createApifyClient,
  getApifyControlTimeoutMs,
} from '@/services/ad-library/apify-config';
import { withApifyTimeout } from '@/services/ad-library/apify-timeout';
import type { XScraperInput } from './x-actor-input';

/** apidojo/twitter-scraper-lite (Actor ID nfp1fpt5gUlBwPcor). */
export const X_SCRAPER_ACTOR_ID = 'apidojo~twitter-scraper-lite';

export class XProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'XProviderError';
    this.retryable = opts.retryable;
  }
}

export interface XRunHandle {
  runId: string;
  datasetId: string;
}

export type XRunStatus =
  | { state: 'running' }
  | { state: 'succeeded' }
  | { state: 'failed'; retryable: boolean };

/**
 * Run-lifecycle harness for the X (Twitter) scraper — a structural twin of
 * the Reddit/Amazon/Google providers (start/poll/abort keyed off run STATUS,
 * never an interim count; paginated dataset reads for mid-dataset resume).
 *
 * Deliberately NOT implemented: the actor's run-sync endpoints (long runs
 * break the HTTP connection) and the runs/last endpoints (racy across
 * concurrent brands) — always address the specific runId/datasetId.
 */
export class XApifyProvider {
  private readonly client: ApifyClient;

  constructor(client?: ApifyClient) {
    this.client = client ?? createApifyClient();
  }

  /**
   * Starts a run without waiting and returns both ids. The caller must
   * persist them immediately — that checkpoint is what makes a crashed or
   * budget-yielded job resume this run instead of starting a new billable one.
   */
  async startRun(input: XScraperInput): Promise<XRunHandle> {
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client.actor(X_SCRAPER_ACTOR_ID).start(input),
        getApifyControlTimeoutMs(),
      );
      return { runId: run.id, datasetId: run.defaultDatasetId };
    } catch (error) {
      throw new XProviderError(
        `X scraper run failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
  }

  /** Status-keyed poll; a missing run is a non-retryable failure. */
  async pollRun(runId: string): Promise<XRunStatus> {
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

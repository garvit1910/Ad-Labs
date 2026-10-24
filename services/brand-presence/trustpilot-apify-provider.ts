import type { ApifyClient } from 'apify-client';
import {
  createApifyClient,
  getApifyControlTimeoutMs,
} from '@/services/ad-library/apify-config';
import { withApifyTimeout } from '@/services/ad-library/apify-timeout';
import type { TrustpilotScraperInput } from './trustpilot-actor-input';

/** memo23/trustpilot-scraper-ppe, pay-per-event billing (~$0.75/1k results) —
 * every run must carry an explicit maxItems. */
export const TRUSTPILOT_SCRAPER_ACTOR_ID = 'memo23~trustpilot-scraper-ppe';

export class TrustpilotProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'TrustpilotProviderError';
    this.retryable = opts.retryable;
  }
}

export interface TrustpilotRunHandle {
  runId: string;
  datasetId: string;
}

export type TrustpilotRunStatus =
  | { state: 'running' }
  | { state: 'succeeded' }
  | { state: 'failed'; retryable: boolean };

/**
 * Run-lifecycle harness for the Trustpilot reviews scraper — a structural
 * twin of the Reddit/Amazon/Google/X providers (start/poll/abort keyed off
 * run STATUS, paginated dataset reads for mid-dataset resume).
 *
 * Deliberately NOT implemented: the actor's run-sync endpoints (long runs
 * break the HTTP connection) and the runs/last endpoints (racy across
 * concurrent brands) — always address the specific runId/datasetId persisted
 * in the checkpoint.
 */
export class TrustpilotApifyProvider {
  private readonly client: ApifyClient;

  constructor(client?: ApifyClient) {
    this.client = client ?? createApifyClient();
  }

  /** Starts a run without waiting; the caller persists both ids immediately
   * so a crashed/yielded job resumes this run instead of re-billing. */
  async startRun(input: TrustpilotScraperInput): Promise<TrustpilotRunHandle> {
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client.actor(TRUSTPILOT_SCRAPER_ACTOR_ID).start(input),
        getApifyControlTimeoutMs(),
      );
      return { runId: run.id, datasetId: run.defaultDatasetId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TrustpilotProviderError(
        `Trustpilot reviews run failed to start: ${message}`,
        { retryable: true },
      );
    }
  }

  /** Status-keyed poll; a missing run is a non-retryable failure. */
  async pollRun(runId: string): Promise<TrustpilotRunStatus> {
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

  /** One page of clean dataset items; a short page (< limit) = exhausted. */
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

import type { ApifyClient } from 'apify-client';
import {
  createApifyClient,
  getApifyControlTimeoutMs,
} from '@/services/ad-library/apify-config';
import { withApifyTimeout } from '@/services/ad-library/apify-timeout';
import type { GoogleMapsReviewsActorInput } from './google-maps-actor-input';

/** compass/google-maps-reviews-scraper (Actor ID Xb8osYTtOjlsgI6k9),
 * pay-per-result billing — every run must carry an explicit maxReviews. */
export const GOOGLE_MAPS_REVIEWS_ACTOR_ID =
  'compass~google-maps-reviews-scraper';

export class GoogleMapsProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'GoogleMapsProviderError';
    this.retryable = opts.retryable;
  }
}

export interface GoogleMapsRunHandle {
  runId: string;
  datasetId: string;
}

export type GoogleMapsRunStatus =
  | { state: 'running' }
  | { state: 'succeeded' }
  | { state: 'failed'; retryable: boolean };

/**
 * Run-lifecycle harness for the Google Maps reviews scraper — a structural
 * twin of the Reddit/Amazon providers (start/poll/abort keyed off run STATUS,
 * paginated dataset reads for mid-dataset resume). Deliberately NOT
 * implemented: the actor's run-sync endpoints (long runs break the HTTP
 * connection) and the runs/last endpoints (racy across concurrent brands) —
 * always address the specific runId/datasetId persisted in the checkpoint.
 */
export class GoogleMapsApifyProvider {
  private readonly client: ApifyClient;

  constructor(client?: ApifyClient) {
    this.client = client ?? createApifyClient();
  }

  /** Starts a run without waiting; the caller persists both ids immediately
   * so a crashed/yielded job resumes this run instead of re-billing. */
  async startRun(
    input: GoogleMapsReviewsActorInput,
  ): Promise<GoogleMapsRunHandle> {
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client.actor(GOOGLE_MAPS_REVIEWS_ACTOR_ID).start(input),
        getApifyControlTimeoutMs(),
      );
      return { runId: run.id, datasetId: run.defaultDatasetId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GoogleMapsProviderError(
        `Google Maps reviews run failed to start: ${message}`,
        { retryable: true },
      );
    }
  }

  /** Status-keyed poll; a missing run is a non-retryable failure. */
  async pollRun(runId: string): Promise<GoogleMapsRunStatus> {
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

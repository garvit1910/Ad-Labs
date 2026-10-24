import type { ApifyClient } from 'apify-client';
import {
  createApifyClient,
  getApifyControlTimeoutMs,
} from '@/services/ad-library/apify-config';
import { withApifyTimeout } from '@/services/ad-library/apify-timeout';
import type {
  TikTokCommentsScraperInput,
  TikTokProfileScraperInput,
} from './tiktok-actor-input';

/** clockworks/tiktok-profile-scraper (Actor ID 0FXVyOXXEmdGcV88a) — Hop 1:
 * username -> videos + per-video commentCount + author card. ~$5/1k items. */
export const TIKTOK_PROFILE_ACTOR_ID = 'clockworks~tiktok-profile-scraper';

/** clockworks/tiktok-comments-scraper (Actor ID BDec00yAmCm1QbMEI) — Hop 2:
 * video URLs -> comments (+ bounded replies). ~$1/1k comments. */
export const TIKTOK_COMMENTS_ACTOR_ID = 'clockworks~tiktok-comments-scraper';

export class TikTokProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'TikTokProviderError';
    this.retryable = opts.retryable;
  }
}

export interface TikTokRunHandle {
  runId: string;
  datasetId: string;
}

export type TikTokRunStatus =
  | { state: 'running' }
  | { state: 'succeeded' }
  | { state: 'failed'; retryable: boolean };

/**
 * Run-lifecycle harness for BOTH TikTok clockworks actors — a structural
 * twin of the Reddit/Amazon/Google/X providers (start/poll/abort keyed off
 * run STATUS, never an interim count; paginated dataset reads for
 * mid-dataset resume). One class carries two actor bindings because
 * poll/abort/dataset calls are run/dataset-addressed and actor-agnostic —
 * each actor stays independently swappable via its ID constant.
 *
 * Deliberately NOT implemented: the actors' run-sync endpoints (long runs
 * break the HTTP connection) and the runs/last endpoints (racy across
 * concurrent brands) — always address the specific runId/datasetId.
 */
export class TikTokApifyProvider {
  private readonly client: ApifyClient;

  constructor(client?: ApifyClient) {
    this.client = client ?? createApifyClient();
  }

  /**
   * Starts a Hop-1 profile run without waiting and returns both ids. The
   * caller must persist them immediately — that checkpoint is what makes a
   * crashed or budget-yielded job resume this run instead of starting a new
   * billable one.
   */
  async startProfileRun(
    input: TikTokProfileScraperInput,
  ): Promise<TikTokRunHandle> {
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client.actor(TIKTOK_PROFILE_ACTOR_ID).start(input),
        getApifyControlTimeoutMs(),
      );
      return { runId: run.id, datasetId: run.defaultDatasetId };
    } catch (error) {
      throw new TikTokProviderError(
        `TikTok profile scraper run failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
  }

  /** Starts a Hop-2 comments run (same persist-immediately contract). */
  async startCommentsRun(
    input: TikTokCommentsScraperInput,
  ): Promise<TikTokRunHandle> {
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client.actor(TIKTOK_COMMENTS_ACTOR_ID).start(input),
        getApifyControlTimeoutMs(),
      );
      return { runId: run.id, datasetId: run.defaultDatasetId };
    } catch (error) {
      throw new TikTokProviderError(
        `TikTok comments scraper run failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
  }

  /** Status-keyed poll; a missing run is a non-retryable failure. */
  async pollRun(runId: string): Promise<TikTokRunStatus> {
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

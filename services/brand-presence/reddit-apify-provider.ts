import type { ApifyClient } from 'apify-client';
import {
  createApifyClient,
  getApifyControlTimeoutMs,
} from '@/services/ad-library/apify-config';
import { withApifyTimeout } from '@/services/ad-library/apify-timeout';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type { RedditScraperLiteInput } from './reddit-actor-input';

/** trudax/reddit-scraper-lite (Actor ID oAuCIx3ItNrs2okjQ). */
export const REDDIT_SCRAPER_ACTOR_ID = 'trudax~reddit-scraper-lite';

/**
 * Run memory (MB) for each Reddit actor run. Read at call time so an operator
 * can override it without a deploy: BRAND_PRESENCE_REDDIT_RUN_MEMORY_MB must be
 * a positive integer; anything else falls back to the config default.
 */
export function getRedditRunMemoryMb(): number {
  const raw = process.env.BRAND_PRESENCE_REDDIT_RUN_MEMORY_MB?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return BRAND_PRESENCE_CONFIG.reddit.runMemoryMb;
}

export class RedditProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'RedditProviderError';
    this.retryable = opts.retryable;
  }
}

export interface RedditRunHandle {
  runId: string;
  datasetId: string;
}

export type RedditRunStatus =
  | { state: 'running' }
  | { state: 'succeeded' }
  | { state: 'failed'; retryable: boolean };

/**
 * Run-lifecycle harness for the Reddit scraper. Mirrors the Layer-1 Apify
 * providers (start/poll/abort keyed off run STATUS, never an interim count)
 * with one addition: paginated dataset reads, so ingestion can resume
 * mid-dataset after a function-budget yield.
 *
 * Deliberately NOT implemented: the actor's run-sync endpoints (long runs
 * break the HTTP connection) and the runs/last endpoints (racy across
 * concurrent brands) — always address the specific runId/datasetId.
 */
export class RedditApifyProvider {
  private readonly client: ApifyClient;

  constructor(client?: ApifyClient) {
    this.client = client ?? createApifyClient();
  }

  /**
   * Starts a run without waiting and returns both ids. The caller must
   * persist them immediately — that checkpoint is what makes a crashed or
   * budget-yielded job resume this run instead of starting a new billable one.
   */
  async startRun(input: RedditScraperLiteInput): Promise<RedditRunHandle> {
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client
          .actor(REDDIT_SCRAPER_ACTOR_ID)
          .start(input, { memory: getRedditRunMemoryMb() }),
        getApifyControlTimeoutMs(),
      );
      return { runId: run.id, datasetId: run.defaultDatasetId };
    } catch (error) {
      throw new RedditProviderError(
        `Reddit scraper run failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
  }

  /** Status-keyed poll; a missing run is a non-retryable failure. */
  async pollRun(runId: string): Promise<RedditRunStatus> {
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

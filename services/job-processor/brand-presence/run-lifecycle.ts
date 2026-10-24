import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';

/**
 * The slice of an Apify provider the poll loop needs — both the Reddit and
 * Amazon providers satisfy it structurally.
 */
export interface ApifyRunPoller {
  pollRun(
    runId: string,
  ): Promise<
    | { state: 'running' }
    | { state: 'succeeded' }
    | { state: 'failed'; retryable: boolean }
  >;
  abortRun(runId: string): Promise<void>;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Brand presence job aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type RunOutcome =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; retryable: boolean; wedged: boolean };

/**
 * Polls a checkpointed Apify run to a terminal state within the function
 * budget. Staleness is state-based — the run keeps polling as long as Apify
 * reports it alive; the wall-clock ceiling only catches genuinely wedged
 * runs, and every abandon path aborts the run FIRST so it stops billing
 * (never restart a run without aborting — that is the Layer-1 billing-loop
 * regression). Throws FunctionTimeoutError to yield: the checkpoint the
 * caller persisted before calling makes the next invocation resume this same
 * run instead of starting a new billable one.
 */
export async function awaitRunCompletion(params: {
  provider: ApifyRunPoller;
  runId: string;
  /** ISO time the run started (from the persisted checkpoint). */
  runStartedAt: string;
  signal: AbortSignal;
  timeoutTracker?: FunctionTimeoutTracker;
  /** Log prefix, e.g. `[BrandPresence] source abc`. */
  label: string;
}): Promise<RunOutcome> {
  const { provider, runId, signal, timeoutTracker, label } = params;
  const startedAtMs = new Date(params.runStartedAt).getTime();

  for (;;) {
    if (signal.aborted) throw new Error('Brand presence job aborted');

    const status = await provider.pollRun(runId);
    if (status.state === 'succeeded') {
      return { outcome: 'succeeded' };
    }
    if (status.state === 'failed') {
      return { outcome: 'failed', retryable: status.retryable, wedged: false };
    }

    // Still running past the ceiling — a wedged run. Abort (stops billing)
    // before failing retryable so job attempts are counted.
    if (Date.now() - startedAtMs > BRAND_PRESENCE_CONFIG.maxRunWallMs) {
      console.warn(`${label}: aborting wedged run ${runId}`);
      try {
        await provider.abortRun(runId);
      } catch (error) {
        console.warn(
          `${label}: failed to abort run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { outcome: 'failed', retryable: true, wedged: true };
    }

    // Still running — yield to the next invocation if out of budget.
    if (timeoutTracker?.shouldStop()) {
      throw new FunctionTimeoutError(
        'Function timeout - will resume on next cron',
      );
    }
    await sleep(BRAND_PRESENCE_CONFIG.pollIntervalMs, signal);
  }
}

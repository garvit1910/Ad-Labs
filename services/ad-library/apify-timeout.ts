import { AdLibraryProviderError } from './types';

/**
 * The Apify SDK exposes no per-call AbortSignal, and its client-level
 * `timeoutSecs` defaults to 360s applied per HTTP request × up to `maxRetries`
 * (default 8) — so a wedged control-plane call (`actor().start()`,
 * `run().get()`, `dataset().listItems()`) can hang far past the 10-min zombie
 * reset, pinning a processor slot. The sync processor's MAX_RUN_WALL_MS
 * ceiling only covers a wedged actor RUN, not a wedged control-plane HTTP
 * call.
 *
 * `withApifyTimeout` bounds each such call in JS: a stalled request rejects
 * with a RETRYABLE `AdLibraryProviderError` the sync loop can resume from,
 * instead of blocking forever. The timer is cleared on BOTH the resolve and
 * reject paths so a fast call never leaves a dangling handle (see the
 * `withTimeout` rule in the root CLAUDE.md). Pair with a bounded client-level
 * `timeoutSecs`/`maxRetries` (see `createApifyClient`) so the underlying socket
 * is torn down too — this only bounds control flow.
 */
export function withApifyTimeout<T>(
  op: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AdLibraryProviderError(
          `Apify ${op} exceeded ${timeoutMs}ms (control-plane stall)`,
          { retryable: true },
        ),
      );
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

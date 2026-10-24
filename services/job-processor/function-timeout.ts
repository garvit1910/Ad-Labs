/**
 * Function Timeout Tracker
 * 
 * Tracks time since function started and provides a way to check if
 * we're approaching the Vercel function timeout. This allows us to
 * gracefully exit and let the next cron pick up the job.
 */

// /api/jobs/process runs with maxDuration 800s (vercel.json). We stop at
// 740s to leave hard-kill slack: one heavy Meta chunk (entity fetch + async
// Insights report + save) for a large account takes 5-8 minutes and must
// complete inside a single invocation, or the chunk restarts from scratch on
// resume (Ember Wellness livelock, 2026-07-02). Keep this below the vercel.json
// maxDuration and keep the job-claimer reaper timeout ABOVE the maxDuration —
// locked by tests/unit/services/job-processor/function-budget-consistency.test.ts.
export const DEFAULT_MAX_DURATION_MS = 740_000;

// Buffer time to perform cleanup before timeout
const CLEANUP_BUFFER_MS = 30_000;

export interface FunctionTimeoutTracker {
  /**
   * Check if we should stop processing to avoid timeout
   * Returns true if we're within CLEANUP_BUFFER_MS of the max duration
   */
  shouldStop: () => boolean;
  
  /**
   * Get remaining time in milliseconds
   */
  getRemainingMs: () => number;
  
  /**
   * Get elapsed time in milliseconds
   */
  getElapsedMs: () => number;
}

export { FunctionTimeoutError } from '@/lib/sync/function-timeout-error';

export function createFunctionTimeoutTracker(
  maxDurationMs: number = DEFAULT_MAX_DURATION_MS
): FunctionTimeoutTracker {
  const startTime = Date.now();
  const stopThreshold = maxDurationMs - CLEANUP_BUFFER_MS;
  
  return {
    shouldStop: () => {
      const elapsed = Date.now() - startTime;
      return elapsed >= stopThreshold;
    },
    
    getRemainingMs: () => {
      const elapsed = Date.now() - startTime;
      return Math.max(0, maxDurationMs - elapsed);
    },
    
    getElapsedMs: () => {
      return Date.now() - startTime;
    }
  };
}


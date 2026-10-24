/**
 * Thrown when a long-running sync must pause because the serverless
 * function budget is nearly exhausted. The job executor treats this as
 * resumable: the job resets to pending and the next cron continues from
 * the last completed chunk.
 *
 * Defined in lib so platform fetch/page loops can throw it directly;
 * services/job-processor/function-timeout.ts re-exports it, so both import
 * paths share one class identity for `instanceof` checks.
 */
export class FunctionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunctionTimeoutError';
  }
}

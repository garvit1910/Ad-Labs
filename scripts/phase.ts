import { setTimeout as sleep } from 'node:timers/promises';
import { serviceSupabase } from '@/lib/adlab/supabase';
import { resetStaleJobs, runWorker } from '@/worker/loop';

/*
 * Shared by the phase scripts (scripts/a2-ingest.ts, scripts/a3-*.ts): the
 * Supabase client, Ctrl-C handling, and draining job_queue with the worker
 * loop (worker/loop.ts) running in-process.
 */

const IDLE_POLL_MS = 10_000;
const PROGRESS_EVERY_MS = 30_000;

export const nowIso = () => new Date().toISOString();

// PostgREST errors are plain objects ({ message, code, details }), not Error instances.
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? JSON.stringify(error)
      : String(error);

export function table(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown) => (value === null || value === undefined ? '' : String(value));
  const widths = keys.map((key) => Math.max(key.length, ...rows.map((row) => cell(row[key]).length)));
  const line = (values: string[]) => values.map((value, i) => value.padEnd(widths[i])).join('  ');
  console.log(line(keys));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(keys.map((key) => cell(row[key]))));
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  error_message: string | null;
}

/** One in-process worker: the job types it claims and how many it runs at a time. */
export interface Pool {
  types: readonly string[];
  concurrency: number;
}

// The profile lookup lives in lib/adlab so worker code can use it without this module's job worker.
export { MAGIC_SPOON_URL, loadBrandProfile, type BrandProfile } from '@/lib/adlab/brand-profile';

/** A phase script's context; `tag` prefixes its log lines. */
export function createPhase(tag: string) {
  const db = serviceSupabase();
  const shutdown = new AbortController();
  process.once('SIGINT', () => {
    console.log(`[${tag}] stopping: in-flight jobs go back to pending (Ctrl-C again to force)`);
    shutdown.abort();
    process.once('SIGINT', () => process.exit(130));
  });

  const log = (message: string) => console.log(`[${tag}] ${message}`);

  /** A read-only query, retried through Supabase network blips (about a minute) before giving up. */
  async function retryRead<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (attempt >= 12 || shutdown.signal.aborted) throw error;
        log(`read failed (${attempt}/12), retrying: ${errorMessage(error)}`);
        await sleep(5_000, undefined, { signal: shutdown.signal });
      }
    }
  }

  async function getJob(jobId: string): Promise<JobRow> {
    const { data, error } = await db.from('job_queue').select('id, type, status, error_message').eq('id', jobId).single();
    if (error) throw error;
    return data as JobRow;
  }

  /** Polls one job until it leaves pending/processing (the in-process lanes run it). */
  async function waitForJob(jobId: string): Promise<JobRow> {
    for (;;) {
      const job = await retryRead(() => getJob(jobId));
      if (job.status !== 'pending' && job.status !== 'processing') return job;
      await sleep(IDLE_POLL_MS, undefined, { signal: shutdown.signal });
    }
  }

  /**
   * Runs the worker pools in-process while `during` does the step's own work, then
   * until no job of their types is pending or processing. One query reads both
   * statuses, so a parent finishing after it enqueued children never reads as idle.
   * A pending job that has used all its attempts is never claimed again
   * (worker/loop.ts claimNext), so it is reported with the failures, not waited on.
   */
  async function drainUntilIdle(label: string, pools: Pool[], during?: () => Promise<void>): Promise<JobRow[]> {
    const startedAt = nowIso();
    const types = pools.flatMap((pool) => pool.types);
    const stale = await resetStaleJobs(db);
    if (stale > 0) log(`reset ${stale} stale processing job(s) to pending`);
    log(`${label}: draining ${pools.map((pool) => `${pool.types.length} job type(s) on ${pool.concurrency} lane(s)`).join(' + ')}`);

    const stop = new AbortController();
    let workerError: unknown = null;
    const workers = Promise.all(
      pools.map((pool) =>
        runWorker(db, { concurrency: pool.concurrency, watch: true, types: pool.types, signal: shutdown.signal, stop: stop.signal }),
      ),
    ).catch((error: unknown) => {
      workerError = error;
      return null;
    });
    const dead = new Map<string, JobRow>();
    try {
      if (during) await during();
      let lastProgress = 0;
      for (;;) {
        if (workerError) throw workerError;
        if (shutdown.signal.aborted) throw new Error('stopped');
        const data = await retryRead(async () => {
          const { data: rows, error } = await db
            .from('job_queue')
            .select('id, type, status, attempts, max_attempts, error_message')
            .in('type', types)
            .in('status', ['pending', 'processing']);
          if (error) throw error;
          return rows ?? [];
        });
        const live = data.filter((row) => {
          if (row.status !== 'pending' || (row.attempts ?? 0) < (row.max_attempts ?? 3)) return true;
          if (!dead.has(row.id)) {
            dead.set(row.id, row as JobRow);
            console.warn(`[${tag}] ${label}: DEAD ${row.type} ${String(row.id).slice(0, 8)}: pending with all ${row.attempts} attempts used, never claimable`);
          }
          return false;
        });
        if (live.length === 0) break;
        if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
          const byType = new Map<string, string>();
          for (const row of live) {
            const key = String(row.type);
            byType.set(key, `${byType.get(key) ?? ''}${row.status === 'processing' ? 'P' : '.'}`);
          }
          log(`${label}: waiting on ${[...byType].map(([type, marks]) => `${type} [${marks}]`).join(', ')}`);
          lastProgress = Date.now();
        }
        await sleep(IDLE_POLL_MS, undefined, { signal: shutdown.signal }).catch(() => {});
      }
    } finally {
      stop.abort();
    }
    const counts = await workers;
    if (workerError) throw workerError;
    if (counts) {
      const sum = (key: keyof (typeof counts)[number]) => counts.reduce((n, c) => n + c[key], 0);
      log(`${label}: idle (${sum('completed')} completed, ${sum('failed')} failed, ${sum('requeued')} requeued, ${sum('skipped')} skipped here)`);
    }

    const { data: failed, error } = await db
      .from('job_queue')
      .select('id, type, status, error_message')
      .in('type', types)
      .eq('status', 'failed')
      .gte('completed_at', startedAt);
    if (error) throw error;
    for (const job of (failed ?? []) as JobRow[]) {
      console.warn(`[${tag}] ${label}: FAILED ${job.type} ${job.id.slice(0, 8)}: ${job.error_message?.slice(0, 300)}`);
    }
    return [...((failed ?? []) as JobRow[]), ...dead.values()];
  }

  return { db, shutdown, log, retryRead, getJob, waitForJob, drainUntilIdle };
}

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getLlmRetryAfterMs } from '@/lib/llm/errors';
import {
  createFunctionTimeoutTracker,
  FunctionTimeoutError,
} from '@/services/job-processor/function-timeout';
import type { Job } from '@/services/job-processor/types';
import { PROCESSOR_REGISTRY, skipReasonFor } from './registry';

// The local job_queue worker of REUSE_MANIFEST §8.4, in place of Adcero's Vercel crons.
// npm run worker (worker/index.ts) and the phase scripts both run it through runWorker.
const POLL_MS = 5_000;
// Above Adcero's 740 s function budget, like its stale-job reaper.
const STALE_PROCESSING_MS = 15 * 60_000;
const RETRY_BASE_MS = 30_000;
const APIFY_SLOT_WAIT_MS = 30_000;
const QUEUE_READ_RETRIES = 12;
const LLM_RATE_LIMIT_PAUSE_MS = 60_000;

/**
 * OpenAI's per-minute token/request limit (429 rate_limit_exceeded), never an
 * exhausted quota. The ad labeller fans a batch out into one vision call per ad,
 * so a 60k-TPM org trips it; the job waits for the window instead of failing.
 */
export function isLlmRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // The stub keeps 500 chars of OpenAI's body, which can cut off the trailing code.
  return /rate_limit_exceeded|Rate limit reached/i.test(message) && !/insufficient_quota/i.test(message);
}

/**
 * Apify refused to start a run because the account is at its concurrent-run or
 * memory limit (5 runs on this plan). Not a failure: the job waits for a slot.
 */
export function isApifyCapacityError(error: unknown): boolean {
  return /By launching this job you will exceed/i.test(error instanceof Error ? error.message : String(error));
}

export interface WorkerOptions {
  /** Jobs run at a time (default 1). */
  concurrency?: number;
  /** Keep polling when nothing is due, instead of returning. */
  watch?: boolean;
  /** Claim only these job types (default: every type). */
  types?: readonly string[];
  /** Shutdown: in-flight jobs go back to pending. */
  signal?: AbortSignal;
  /** Graceful stop: each lane finishes its current job, then returns. */
  stop?: AbortSignal;
  /**
   * Called after each claim and each finish (the ingest_job mirror, lib/adlab/ingest-mirror.ts).
   * Runs through safeNotify: a hook that throws or hangs never touches the job.
   */
  onTransition?: JobTransitionHook;
}

/** A job_queue status a job moves to. */
export type JobQueueStatus = 'processing' | 'pending' | 'completed' | 'failed' | 'cancelled';

export interface JobTransition {
  jobId: string;
  type: string;
  from: string;
  to: JobQueueStatus;
  /** The row's error_message after the move (the retry or pause reason, the failure), or null. */
  error: string | null;
  attempts: number;
}

export type JobTransitionHook = (t: JobTransition) => Promise<void>;

const NOTIFY_TIMEOUT_MS = 5_000;

/** Runs a transition hook with a timeout and a catch: it can delay a job by at most the timeout, never fail it. */
export async function safeNotify(
  hook: JobTransitionHook | undefined,
  t: JobTransition,
  opts: { timeoutMs?: number; warn?: (line: string) => void } = {},
): Promise<void> {
  if (!hook) return;
  const warn = opts.warn ?? console.warn;
  const what = `[worker] transition hook ${t.type} ${t.jobId.slice(0, 8)} -> ${t.to}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), opts.timeoutMs ?? NOTIFY_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([Promise.resolve().then(() => hook(t)).then(() => 'ok' as const), timeout]);
    if (outcome === 'timeout') warn(`${what}: timed out`);
  } catch (error) {
    warn(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface WorkerCounts {
  completed: number;
  failed: number;
  requeued: number;
  skipped: number;
}

const nowIso = () => new Date().toISOString();

/** A worker that died mid-job leaves its row in processing; hand it back. */
export async function resetStaleJobs(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('job_queue')
    .update({ status: 'pending', started_at: null, claim_token: null })
    .eq('status', 'processing')
    .lt('started_at', new Date(Date.now() - STALE_PROCESSING_MS).toISOString())
    .select('id');
  if (error) throw error;
  return data.length;
}

export async function runWorker(db: SupabaseClient, options: WorkerOptions = {}): Promise<WorkerCounts> {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const shutdown = options.signal ?? new AbortController().signal;
  const wake = AbortSignal.any([shutdown, ...(options.stop ? [options.stop] : [])]);
  const counts: WorkerCounts = { completed: 0, failed: 0, requeued: 0, skipped: 0 };
  // Job type -> epoch ms until which this worker claims none of it (after an LLM rate limit).
  const pausedUntil = new Map<string, number>();

  async function claimNext(): Promise<Job | null> {
    let query = db.from('job_queue').select('*').eq('status', 'pending').lte('scheduled_for', nowIso());
    if (options.types) query = query.in('type', [...options.types]);
    const paused = [...pausedUntil].filter(([, until]) => until > Date.now()).map(([type]) => type);
    if (paused.length) query = query.not('type', 'in', `(${paused.join(',')})`);
    const { data, error } = await query
      .order('priority', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const row of data ?? []) {
      const attempts = row.attempts ?? 0;
      if (attempts >= (row.max_attempts ?? 3)) continue;
      // Conditional on still-pending, so two workers can never take the same row.
      const { data: claimed, error: claimError } = await db
        .from('job_queue')
        .update({ status: 'processing', attempts: attempts + 1, started_at: nowIso(), claim_token: randomUUID() })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('*')
        .maybeSingle();
      if (claimError) throw claimError;
      if (claimed) return { ...claimed, max_attempts: claimed.max_attempts ?? 3 } as Job;
    }
    return null;
  }

  async function finish(job: Job, patch: Record<string, unknown>): Promise<void> {
    const { error } = await db.from('job_queue').update(patch).eq('id', job.id).eq('claim_token', job.claim_token!);
    if (error) throw error;
    await safeNotify(options.onTransition, {
      jobId: job.id,
      type: job.type,
      from: 'processing',
      to: patch.status as JobQueueStatus,
      error:
        typeof patch.error_message === 'string'
          ? patch.error_message.slice(0, 500)
          : ((patch.result as { skipped?: string } | undefined)?.skipped ?? null),
      attempts: typeof patch.attempts === 'number' ? patch.attempts : job.attempts,
    });
  }

  async function runJob(job: Job): Promise<void> {
    const tag = `${job.type} ${job.id.slice(0, 8)} (attempt ${job.attempts}/${job.max_attempts})`;
    await safeNotify(options.onTransition, { jobId: job.id, type: job.type, from: 'pending', to: 'processing', error: null, attempts: job.attempts });
    const skipReason = skipReasonFor(job.type);
    if (skipReason) {
      await finish(job, { status: 'cancelled', completed_at: nowIso(), error_message: null, result: { skipped: skipReason } });
      counts.skipped++;
      console.log(`[worker] ${tag} skipped: ${skipReason}`);
      return;
    }
    const startedAt = Date.now();
    const factory = PROCESSOR_REGISTRY[job.type];
    try {
      if (!factory) throw new Error(`Unknown job type: ${job.type}`);
      await factory(db).process(job, shutdown, createFunctionTimeoutTracker());
      await finish(job, { status: 'completed', completed_at: nowIso(), error_message: null });
      counts.completed++;
      console.log(`[worker] ${tag} completed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof FunctionTimeoutError || shutdown.aborted) {
        // Adcero's pause: not a failure, so the attempt is refunded and the job resumes next claim.
        await finish(job, { status: 'pending', started_at: null, claim_token: null, error_message: null, attempts: Math.max(0, job.attempts - 1) });
        counts.requeued++;
        console.log(`[worker] ${tag} paused, requeued: ${message}`);
      } else if (isApifyCapacityError(error)) {
        await finish(job, {
          status: 'pending',
          started_at: null,
          claim_token: null,
          error_message: message,
          attempts: Math.max(0, job.attempts - 1),
          scheduled_for: new Date(Date.now() + APIFY_SLOT_WAIT_MS).toISOString(),
        });
        counts.requeued++;
        console.log(`[worker] ${tag} waiting for an Apify run slot, retrying in ${APIFY_SLOT_WAIT_MS / 1000}s`);
      } else if (isLlmRateLimitError(error)) {
        pausedUntil.set(job.type, Date.now() + LLM_RATE_LIMIT_PAUSE_MS);
        await finish(job, {
          status: 'pending',
          started_at: null,
          claim_token: null,
          error_message: message.slice(0, 500),
          attempts: Math.max(0, job.attempts - 1),
          scheduled_for: new Date(Date.now() + LLM_RATE_LIMIT_PAUSE_MS).toISOString(),
        });
        counts.requeued++;
        console.log(`[worker] ${tag} hit the LLM rate limit; ${job.type} paused ${LLM_RATE_LIMIT_PAUSE_MS / 1000}s`);
      } else if (!factory || job.attempts >= job.max_attempts) {
        await finish(job, { status: 'failed', completed_at: nowIso(), error_message: message });
        counts.failed++;
        console.error(`[worker] ${tag} failed: ${message}`);
      } else {
        const delayMs = getLlmRetryAfterMs(error) ?? RETRY_BASE_MS * job.attempts;
        await finish(job, {
          status: 'pending',
          started_at: null,
          claim_token: null,
          error_message: message,
          scheduled_for: new Date(Date.now() + delayMs).toISOString(),
        });
        counts.requeued++;
        console.warn(`[worker] ${tag} errored, retrying in ${Math.round(delayMs / 1000)}s: ${message}`);
      }
    }
  }

  async function lane(): Promise<void> {
    let readFailures = 0;
    while (!wake.aborted) {
      let job: Job | null;
      try {
        job = await claimNext();
        readFailures = 0;
      } catch (error) {
        // A network blip to Supabase must not kill an hour-long drain; a lasting outage still does.
        if (++readFailures >= QUEUE_READ_RETRIES) throw error;
        console.warn(`[worker] queue read failed (${readFailures}/${QUEUE_READ_RETRIES}), retrying: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
        await sleep(POLL_MS, undefined, { signal: wake }).catch(() => {});
        continue;
      }
      if (job) {
        await runJob(job);
        continue;
      }
      if (!options.watch) return;
      await sleep(POLL_MS, undefined, { signal: wake }).catch(() => {});
    }
  }

  await Promise.all(Array.from({ length: concurrency }, lane));
  return counts;
}

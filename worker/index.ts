import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { serviceSupabase } from '@/lib/adlab/supabase';
import { getLlmRetryAfterMs } from '@/lib/llm/errors';
import {
  createFunctionTimeoutTracker,
  FunctionTimeoutError,
} from '@/services/job-processor/function-timeout';
import type { Job } from '@/services/job-processor/types';
import { PROCESSOR_REGISTRY } from './registry';

// The local job_queue worker of REUSE_MANIFEST §8.4, in place of Adcero's Vercel crons.
// Default: drain every due pending job (including the ones processors chain), then exit.
// --watch keeps polling; --concurrency=N runs N jobs at a time.
const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const CONCURRENCY = Math.max(1, Number(args.find((a) => a.startsWith('--concurrency='))?.split('=')[1]) || 1);
const POLL_MS = 5_000;
// Above Adcero's 740 s function budget, like its stale-job reaper.
const STALE_PROCESSING_MS = 15 * 60_000;
const RETRY_BASE_MS = 30_000;

const db = serviceSupabase();
const shutdown = new AbortController();
const counts = { completed: 0, failed: 0, requeued: 0 };
const nowIso = () => new Date().toISOString();

async function claimNext(): Promise<Job | null> {
  const { data, error } = await db
    .from('job_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', nowIso())
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
}

async function runJob(job: Job): Promise<void> {
  const tag = `${job.type} ${job.id.slice(0, 8)} (attempt ${job.attempts}/${job.max_attempts})`;
  const startedAt = Date.now();
  const factory = PROCESSOR_REGISTRY[job.type];
  try {
    if (!factory) throw new Error(`Unknown job type: ${job.type}`);
    await factory(db).process(job, shutdown.signal, createFunctionTimeoutTracker());
    await finish(job, { status: 'completed', completed_at: nowIso(), error_message: null });
    counts.completed++;
    console.log(`[worker] ${tag} completed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof FunctionTimeoutError || shutdown.signal.aborted) {
      // Adcero's pause: not a failure, so the attempt is refunded and the job resumes next claim.
      await finish(job, { status: 'pending', started_at: null, claim_token: null, error_message: null, attempts: Math.max(0, job.attempts - 1) });
      counts.requeued++;
      console.log(`[worker] ${tag} paused, requeued: ${message}`);
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
  while (!shutdown.signal.aborted) {
    const job = await claimNext();
    if (job) {
      await runJob(job);
      continue;
    }
    if (!WATCH) return;
    await sleep(POLL_MS, undefined, { signal: shutdown.signal }).catch(() => {});
  }
}

process.once('SIGINT', () => {
  console.log('[worker] stopping: in-flight jobs go back to pending (Ctrl-C again to force)');
  shutdown.abort();
  process.once('SIGINT', () => process.exit(130));
});

// A worker that died mid-job leaves its row in processing; hand it back.
const { data: stale, error: staleError } = await db
  .from('job_queue')
  .update({ status: 'pending', started_at: null, claim_token: null })
  .eq('status', 'processing')
  .lt('started_at', new Date(Date.now() - STALE_PROCESSING_MS).toISOString())
  .select('id');
if (staleError) throw staleError;
if (stale.length > 0) console.log(`[worker] reset ${stale.length} stale processing job(s) to pending`);

console.log(
  `[worker] ${WATCH ? 'watching' : 'draining'} job_queue: ${CONCURRENCY} lane(s), ${Object.keys(PROCESSOR_REGISTRY).length} job types`,
);
await Promise.all(Array.from({ length: CONCURRENCY }, lane));

const { count: later, error: laterError } = await db
  .from('job_queue')
  .select('id', { count: 'exact', head: true })
  .eq('status', 'pending');
if (laterError) throw laterError;
console.log(
  `[worker] ${shutdown.signal.aborted ? 'stopped' : 'drained'}: ${counts.completed} completed, ${counts.failed} failed, ${counts.requeued} requeued` +
    (later ? `; ${later} pending for later (rerun, or use --watch)` : ''),
);

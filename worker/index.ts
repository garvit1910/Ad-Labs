import { serviceSupabase } from '@/lib/adlab/supabase';
import { PROCESSOR_REGISTRY } from './registry';
import { resetStaleJobs, runWorker } from './loop';

// npm run worker: the job_queue worker loop (worker/loop.ts) from the command line.
// Default: drain every due pending job (including the ones processors chain), then exit.
// --watch keeps polling; --concurrency=N runs N jobs at a time.
const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const CONCURRENCY = Math.max(1, Number(args.find((a) => a.startsWith('--concurrency='))?.split('=')[1]) || 1);

const db = serviceSupabase();
const shutdown = new AbortController();

process.once('SIGINT', () => {
  console.log('[worker] stopping: in-flight jobs go back to pending (Ctrl-C again to force)');
  shutdown.abort();
  process.once('SIGINT', () => process.exit(130));
});

const stale = await resetStaleJobs(db);
if (stale > 0) console.log(`[worker] reset ${stale} stale processing job(s) to pending`);

console.log(
  `[worker] ${WATCH ? 'watching' : 'draining'} job_queue: ${CONCURRENCY} lane(s), ${Object.keys(PROCESSOR_REGISTRY).length} job types`,
);
const counts = await runWorker(db, { concurrency: CONCURRENCY, watch: WATCH, signal: shutdown.signal });

const { count: later, error: laterError } = await db
  .from('job_queue')
  .select('id', { count: 'exact', head: true })
  .eq('status', 'pending');
if (laterError) throw laterError;
console.log(
  `[worker] ${shutdown.signal.aborted ? 'stopped' : 'drained'}: ${counts.completed} completed, ${counts.failed} failed, ${counts.requeued} requeued` +
    (counts.skipped ? `, ${counts.skipped} skipped` : '') +
    (later ? `; ${later} pending for later (rerun, or use --watch)` : ''),
);

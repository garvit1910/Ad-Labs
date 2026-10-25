import { setTimeout as sleep } from 'node:timers/promises';
import { connectSpacetime } from '@/lib/adlab/spacetime-http';
import { serviceSupabase } from '@/lib/adlab/supabase';
import { ClaimLostError, CREATIVE_WORKER, failTask, runGenerateCreatives, type RunDeps } from './run';

export interface CreativeLoopOptions extends RunDeps {
  signal: AbortSignal;
  /** A queued task must sit unclaimed this long first, so A6's Copywriter goes first. */
  minAgeMs?: number;
  /** A task claimed by anyone and untouched this long is abandoned and taken over. */
  staleClaimMs?: number;
  pollMs?: number;
  /** Tries per task (resumed on the next poll) before it's failed. */
  maxAttempts?: number;
}

interface TaskHead {
  task_id: string;
  status: string;
  claimed_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The creative worker's task-board loop. Each poll it resumes generate_creatives
 * tasks it already claimed, takes over tasks someone else claimed and left
 * untouched for 15 minutes (a stopped Copywriter; no reducer requeues a claim),
 * then claims queued ones that have waited at least a minute, oldest first. A task
 * that keeps failing is failed after `maxAttempts` tries.
 */
export async function runCreativeTaskLoop(opts: CreativeLoopOptions): Promise<void> {
  const { signal } = opts;
  const minAgeMs = opts.minAgeMs ?? 60_000;
  const staleClaimMs = opts.staleClaimMs ?? 15 * 60_000;
  const pollMs = opts.pollMs ?? 10_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const log = opts.log ?? ((line: string) => console.log(`[creatives] ${line}`));
  const spacetime = opts.spacetime ?? (await connectSpacetime());
  // Live facts are re-read for every task unless the caller pinned rows (tests do).
  const deps = {
    spacetime,
    ...(opts.client ? { client: opts.client } : { db: opts.db ?? serviceSupabase() }),
    ...(opts.log ? { log: opts.log } : {}),
  };
  const attempts = new Map<string, number>();

  log(`watching generate_creatives tasks on ${spacetime.label} as ${CREATIVE_WORKER} (claims after ${minAgeMs / 1000}s unclaimed)`);
  while (!signal.aborted) {
    let tasks: TaskHead[] = [];
    try {
      tasks = await spacetime.sql<TaskHead>("SELECT * FROM task WHERE kind = 'generate_creatives'");
    } catch (error) {
      log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const now = Date.now();
    const age = (iso: string) => now - Date.parse(iso);
    const due = tasks
      .filter(
        (task) =>
          (task.status === 'claimed' && (task.claimed_by === CREATIVE_WORKER || age(task.updated_at) >= staleClaimMs)) ||
          (task.status === 'queued' && age(task.created_at) >= minAgeMs),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id));

    for (const task of due) {
      if (signal.aborted) break;
      const takeover = task.status === 'claimed' && task.claimed_by !== CREATIVE_WORKER;
      try {
        await runGenerateCreatives(task.task_id, { ...deps, takeover });
        attempts.delete(task.task_id);
      } catch (error) {
        if (error instanceof ClaimLostError) {
          log(error.message);
          continue;
        }
        const tries = (attempts.get(task.task_id) ?? 0) + 1;
        attempts.set(task.task_id, tries);
        const message = error instanceof Error ? error.message : String(error);
        if (tries < maxAttempts) {
          log(`${task.task_id} failed (try ${tries}/${maxAttempts}), retrying next poll: ${message}`);
          continue;
        }
        log(`${task.task_id} failed ${tries} times, failing the task: ${message}`);
        // A taken-over task is still held by its first claimer.
        const holder = takeover ? (task.claimed_by ?? CREATIVE_WORKER) : CREATIVE_WORKER;
        await failTask(spacetime, task.task_id, error, holder).catch((failError: unknown) => log(`fail_task: ${String(failError)}`));
        attempts.delete(task.task_id);
      }
    }
    await sleep(pollMs, undefined, { signal }).catch(() => {});
  }
  log('stopped');
}

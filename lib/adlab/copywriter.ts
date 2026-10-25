import type { SupabaseClient } from '@supabase/supabase-js';
import { ClaimLostError, failTask, readTask, runGenerateCreatives, type TaskResult } from '@/worker/creatives/run';
import type { Spacetime } from './spacetime-http';

/*
 * The Copywriter's side of a generate_creatives task (POST /api/agent/creatives/generate and
 * /creatives/fail). The route never fails the task itself: a throw leaves it claimed by
 * 'copywriter', the Copywriter retries (each retry resumes the held claim), then calls
 * /creatives/fail. A5's worker loop takes over a claim left untouched for 15 minutes.
 */

export const COPYWRITER = 'copywriter';

export type CopywriterErrorCode = 'task_not_found' | 'bad_request' | 'claim_lost' | 'generate_failed';

export class CopywriterError extends Error {
  constructor(
    readonly code: CopywriterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CopywriterError';
  }
}

export interface GenerateRequest {
  task_id: string;
  learning_ids?: string[];
  next_round?: 'queue' | 'skip';
}

export type GenerateResponse = TaskResult & { learning_ids_applied: string[] };

export interface CopywriterDeps {
  spacetime: Spacetime;
  db?: SupabaseClient;
  /** Tests inject the run; the route uses A5's runGenerateCreatives. */
  run?: typeof runGenerateCreatives;
  log?: (line: string) => void;
}

// One in-flight call per task, on globalThis so Next's dev reloads share it: a repeat call joins.
const inflight: Map<string, Promise<GenerateResponse>> = ((globalThis as { __adlabCopywriterInflight?: Map<string, Promise<GenerateResponse>> })
  .__adlabCopywriterInflight ??= new Map());

async function generateOnce(req: GenerateRequest, deps: CopywriterDeps): Promise<GenerateResponse> {
  const task = await readTask(deps.spacetime, req.task_id);
  if (!task) throw new CopywriterError('task_not_found', `task ${req.task_id} not found`);
  if (task.kind !== 'generate_creatives') throw new CopywriterError('bad_request', `task ${req.task_id} is ${task.kind}, not generate_creatives`);
  const run = deps.run ?? runGenerateCreatives;
  try {
    const result = await run(req.task_id, {
      claimedBy: COPYWRITER,
      spacetime: deps.spacetime,
      db: deps.db,
      learningIds: req.learning_ids,
      nextRound: req.next_round ?? 'queue',
      log: deps.log ?? ((line: string) => console.log(`[copywriter ${req.task_id}] ${line}`)),
    });
    return { ...result, learning_ids_applied: result.learning_ids_applied ?? [] };
  } catch (error) {
    if (error instanceof ClaimLostError) throw new CopywriterError('claim_lost', error.message);
    // Never failTask here: the task stays claimed by the Copywriter, which retries, then calls /creatives/fail.
    throw new CopywriterError('generate_failed', error instanceof Error ? error.message : String(error));
  }
}

/** Runs the task for the Copywriter, or joins the call already running for it. */
export function generateForCopywriter(req: GenerateRequest, deps: CopywriterDeps): Promise<GenerateResponse> {
  const pending = inflight.get(req.task_id);
  if (pending) return pending;
  const promise = generateOnce(req, deps).finally(() => inflight.delete(req.task_id));
  inflight.set(req.task_id, promise);
  return promise;
}

/** Fails the task only while the Copywriter still holds it. */
export async function failForCopywriter(spacetime: Spacetime, taskId: string, error: string): Promise<{ failed: boolean }> {
  return { failed: await failTask(spacetime, taskId, error, COPYWRITER) };
}

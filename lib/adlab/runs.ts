import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientRows } from '@/worker/creatives/facts';
import { roundZeroStatus, type RoundZeroStatus } from '@/worker/creatives/run';
import type { Spacetime, SpacetimeTarget, SqlRow } from './spacetime-http';
import { DEMO_DATABASE, runsAllowed } from './targets';

/*
 * Starting a simulation run on the task board, shared by `npm run bench -- start-run` and the
 * agents' POST /api/agent/rounds/start. B's worker creates or updates the run row when it runs
 * round 0, keeping a pre-existing row's seed, population and rounds_planned (B's D63/D64), so the
 * row is pre-created here with those settings and a placeholder status, then round 0 is queued.
 * After round 0 starts, nothing here writes the run row again.
 */

export type RunRefusal = 'runs_not_allowed' | 'bad_request' | 'db_has_run' | 'run_exists' | 'round0_incomplete';

export class RunRefusedError extends Error {
  constructor(
    readonly code: RunRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'RunRefusedError';
  }
}

export const RUN_ID = /^run_[a-z0-9_]{1,40}$/;
export const ROUNDS = { min: 1, max: 5, default: 3 } as const;
export const POPULATION = { min: 50, max: 300, default: 300 } as const;
export const DEFAULT_SEED = 13;
/** B's ticks per round (sim/src/config.ts); the worker writes its own value after calibrating. */
const TICKS_PER_ROUND = 3;
/** The placeholder row's status and hash until B's worker has calibrated round 0. */
export const PLACEHOLDER = { status: 'calibrating', config_hash: 'pending' } as const;

export const runTaskId = (runId: string, round: number) => `tsk_run_${runId}_r${round}`;

export interface StartRunInput {
  runId: string;
  roundsPlanned?: number;
  population?: number;
  seed?: number;
  requestedBy: string;
  /** Local debugging only: start beside another run. The agents never send it. */
  allowOtherRuns?: boolean;
}

export interface StartRunResult {
  run_id: string;
  task_id: string;
  rounds_planned: number;
  population: number;
  seed: number;
  /** True when this call re-queued round 0 for its own leftover placeholder row. */
  requeued: boolean;
}

export interface StartRunDeps {
  /** Defaults to spacetime.target (set by connectSpacetime). */
  target?: SpacetimeTarget;
  db?: SupabaseClient;
  client?: ClientRows;
  /** Tests inject the round-0 verdict; otherwise A5's roundZeroStatus reads both databases. */
  roundZero?: () => Promise<RoundZeroStatus>;
}

function intIn(name: string, value: number | undefined, range: { min: number; max: number; default: number }): number {
  const v = value ?? range.default;
  if (!Number.isInteger(v) || v < range.min || v > range.max) {
    throw new RunRefusedError('bad_request', `${name} must be an integer from ${range.min} to ${range.max}, got ${value}`);
  }
  return v;
}

const isPlaceholder = (row: SqlRow, tasks: SqlRow[]) =>
  row.status === PLACEHOLDER.status && row.config_hash === PLACEHOLDER.config_hash && tasks.length === 0;

export async function startRun(spacetime: Spacetime, input: StartRunInput, deps: StartRunDeps = {}): Promise<StartRunResult> {
  const target = deps.target ?? spacetime.target;
  if (!target) throw new RunRefusedError('runs_not_allowed', 'unknown database target; connect with connectSpacetime()');
  if (!runsAllowed(target)) {
    const why = target.dbName === DEMO_DATABASE ? "it is B's demo database" : 'only the local bench or the stage database may host agent runs';
    throw new RunRefusedError('runs_not_allowed', `no agent runs on ${target.label}: ${why}`);
  }

  const runId = input.runId.trim();
  if (!RUN_ID.test(runId)) throw new RunRefusedError('bad_request', `run_id "${input.runId}" must match ${RUN_ID}`);
  const roundsPlanned = intIn('rounds_planned', input.roundsPlanned, ROUNDS);
  const population = intIn('population', input.population, POPULATION);
  const seed = input.seed ?? DEFAULT_SEED;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RunRefusedError('bad_request', `seed must be a u32, got ${input.seed}`);

  const [runs, tasks] = await Promise.all([spacetime.sql('SELECT * FROM run'), spacetime.sql('SELECT * FROM task')]);
  const own = runs.find((row) => row.run_id === runId);
  const ownTasks = tasks.filter((task) => task.run_id === runId);
  if (own && !isPlaceholder(own, ownTasks)) {
    throw new RunRefusedError('run_exists', `run ${runId} already exists (status ${String(own.status)})`);
  }
  if (!own && ownTasks.length) throw new RunRefusedError('run_exists', `run ${runId} already has tasks on the board`);

  const others = [
    ...new Set([
      ...runs.filter((row) => row.run_id !== runId).map((row) => String(row.run_id)),
      ...tasks.filter((task) => task.kind === 'run_round' && task.run_id !== runId).map((task) => String(task.run_id)),
    ]),
  ];
  if (others.length && !(input.allowOtherRuns && target.isLocal)) {
    throw new RunRefusedError(
      'db_has_run',
      `${target.dbName} already holds ${others.join(', ')}; the creative table has no run column, so a second run would see that run's ads. Reset the database first.`,
    );
  }

  const status = await (deps.roundZero ? deps.roundZero() : roundZeroStatus({ spacetime, db: deps.db, client: deps.client }));
  if (!status.complete) throw new RunRefusedError('round0_incomplete', `round 0 is not complete: ${status.problems.join('; ')}`);

  await spacetime.call('upsert_run', [
    JSON.stringify({
      run_id: runId,
      seed,
      population,
      rounds_planned: roundsPlanned,
      ticks_per_round: TICKS_PER_ROUND,
      status: PLACEHOLDER.status,
      calibration: '{}',
      jev_model: 'jev-1.13.0',
      config_hash: PLACEHOLDER.config_hash,
    }),
  ]);
  const taskId = runTaskId(runId, 0);
  await spacetime.call('enqueue_task', [taskId, 'run_round', JSON.stringify({ run_id: runId, round: 0 })]);
  return { run_id: runId, task_id: taskId, rounds_planned: roundsPlanned, population, seed, requeued: Boolean(own) };
}

import { spawn, type ChildProcess } from 'node:child_process';
import { connectSpacetime, resolveSpacetimeTarget, sqlString } from '@/lib/adlab/spacetime-http';
import { nextReplayId, replayProgress, type ReplayInfo, type ReplayState } from '@/app/sim/_lib/replay';

// Runs B's replay (`npm --prefix sim run sim:replay`, sim/src/replay.ts) as a child of the Next
// server, one at a time, against the database this server targets (SPACETIMEDB_URI /
// SPACETIMEDB_DB_NAME, set by `npm run dev:local` or `dev:live`). The replay is off the task
// board, so the agents never act on it. It writes a new run, so on Maincloud it runs only when
// SIM_REPLAY_ALLOW_MAINCLOUD=1 says so on purpose (it then passes sim:replay's --allow-maincloud).

export class ReplayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

type Job = ReplayState & { child: ChildProcess | null; stopping: boolean };
// `starting` holds the slot across the checks' awaits, so two quick POSTs can't both spawn.
type Memo = { job: Job | null; starting: boolean };
// On globalThis so Next's dev reloads keep track of a replay that is still running.
const memo: Memo = ((globalThis as { __simReplay?: Memo }).__simReplay ??= { job: null, starting: false });

const LOG_LINES = 80;
const RUN_ID = /^run_[a-z0-9_]{1,60}$/;

function policy(): Omit<ReplayInfo, 'replay'> {
  const target = resolveSpacetimeTarget();
  if (target.isLocal) return { allowed: true, reason: '', target: target.label };
  if (process.env.SIM_REPLAY_ALLOW_MAINCLOUD?.trim() === '1') return { allowed: true, reason: '', target: target.label };
  return {
    allowed: false,
    reason: `replays write a new run, so they only run on a local database (set SIM_REPLAY_ALLOW_MAINCLOUD=1 to allow ${target.dbName})`,
    target: target.label,
  };
}

const publicState = (job: Job | null): ReplayState | null => {
  if (!job) return null;
  const { child: _child, stopping: _stopping, ...state } = job;
  return { ...state, log: [...state.log] };
};

export function replayInfo(): ReplayInfo {
  return { ...policy(), replay: publicState(memo.job) };
}

// The child gets this server's env minus Next's own internals, so sim:replay reads the same
// SPACETIMEDB_* target and the repo's .env.local the way the sim worker does.
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('__NEXT') && key !== 'NODE_OPTIONS'),
  ) as NodeJS.ProcessEnv;
}

// sim:replay has no signal handler and stops before writing "done", so a stopped or failed replay
// would leave its run and open round "running" for good (and the newest run is /sim's default).
async function closeRun(as: string, status: 'stopped' | 'failed'): Promise<void> {
  try {
    const spacetime = await connectSpacetime();
    const [run] = await spacetime.sql(`SELECT * FROM run WHERE run_id = ${sqlString(as)}`);
    if (run && run.status !== 'done') await spacetime.call('upsert_run', [JSON.stringify({ ...run, status })]);
    for (const round of await spacetime.sql(`SELECT * FROM round WHERE run_id = ${sqlString(as)}`)) {
      if (round.status === 'running') await spacetime.call('finish_round', [as, Number(round.round), status, '{}']);
    }
  } catch (err) {
    console.error(`[sim replay] could not mark ${as} ${status}:`, err);
  }
}

export async function startReplay(from: string, dayMs: number): Promise<ReplayState> {
  if (memo.starting || memo.job?.status === 'running') {
    throw new ReplayError(409, memo.job?.status === 'running' ? `a replay is already running: ${memo.job.from} as ${memo.job.as}` : 'a replay is starting');
  }
  if (!RUN_ID.test(from)) throw new ReplayError(400, `"${from}" is not a run id`);
  const rules = policy();
  if (!rules.allowed) throw new ReplayError(403, rules.reason);
  memo.starting = true;
  try {
    return await spawnReplay(from, dayMs);
  } finally {
    memo.starting = false;
  }
}

async function spawnReplay(from: string, dayMs: number): Promise<ReplayState> {
  const spacetime = await connectSpacetime();
  const runs = await spacetime.sql('SELECT * FROM run');
  const source = runs.find((run) => run.run_id === from);
  if (!source) throw new ReplayError(404, `no run ${from} on ${spacetime.label}`);
  if (source.status !== 'done') throw new ReplayError(409, `run ${from} is ${String(source.status)}; only a finished run can be replayed`);
  const as = nextReplayId(from, runs.map((run) => String(run.run_id)));

  const args = ['--prefix', 'sim', 'run', '-s', 'sim:replay', '--', '--from', from, '--as', as, '--day-ms', String(dayMs)];
  if (!spacetime.target?.isLocal) args.push('--allow-maincloud');
  const child = spawn('npm', args, { cwd: process.cwd(), env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const job: Job = {
    from,
    as,
    dayMs,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    roundsDone: 0,
    roundsTotal: Number(source.rounds_planned) + 1,
    message: `replaying ${from} as ${as}`,
    log: [],
    child,
    stopping: false,
  };
  memo.job = job;

  let partial = '';
  let outcome: string | null = null;
  const onData = (chunk: Buffer) => {
    const lines = (partial + chunk.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    const fresh = lines.map((l) => l.trimEnd()).filter(Boolean);
    // Progress counts each batch once; the log itself is capped for display only.
    const progress = replayProgress(fresh);
    job.roundsDone += progress.roundsDone;
    job.roundsTotal = progress.roundsTotal ?? job.roundsTotal;
    outcome = progress.outcome ?? outcome;
    for (const line of fresh) {
      job.log.push(line);
      if (job.log.length > LOG_LINES) job.log.shift();
    }
    job.message = outcome ?? job.log.at(-1) ?? job.message;
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (err) => {
    job.status = 'failed';
    job.message = `could not start sim:replay: ${err.message}`;
    job.finishedAt = new Date().toISOString();
    job.child = null;
  });
  child.on('exit', (code) => {
    if (partial.trim()) onData(Buffer.from('\n'));
    const status = job.stopping ? 'stopped' : code === 0 ? 'done' : 'failed';
    if (job.stopping) job.message = `stopped after ${job.roundsDone} round(s)`;
    if (status !== 'done') void closeRun(as, status);
    job.status = status;
    job.finishedAt = new Date().toISOString();
    job.child = null;
  });
  return publicState(job)!;
}

export function stopReplay(): ReplayState | null {
  const job = memo.job;
  if (!job || job.status !== 'running' || !job.child) return publicState(job);
  job.stopping = true;
  const child = job.child;
  child.kill('SIGINT');
  setTimeout(() => {
    if (job.child === child) child.kill('SIGTERM');
  }, 5_000).unref();
  return publicState(job);
}

// The /sim replay button and its route (app/api/sim/replay) share these. A replay re-runs a
// finished run from the Jev cache under a new run id (sim/src/replay.ts, D77), pausing after each
// sim day, so /sim fills live with identical numbers and no Jev calls.

export const REPLAY_SPEEDS = [
  { dayMs: 1000, label: 'Fast · 1 s / day' },
  { dayMs: 3000, label: 'Normal · 3 s / day' },
  { dayMs: 6000, label: 'Slow · 6 s / day' },
] as const;

export const DEFAULT_DAY_MS = 3000;
export const MIN_DAY_MS = 250;
export const MAX_DAY_MS = 20_000;

export type ReplayStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface ReplayState {
  from: string;
  as: string;
  dayMs: number;
  status: ReplayStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Rounds the replay has finished, and how many it will run (warm-up included). */
  roundsDone: number;
  roundsTotal: number | null;
  /** The outcome line ("identical to …", the error), or the latest progress line. */
  message: string;
  log: string[];
}

export interface ReplayInfo {
  /** Whether this server may replay into its database (local always; Maincloud only on purpose). */
  allowed: boolean;
  reason: string;
  target: string;
  replay: ReplayState | null;
}

/** The replay's run id, the way sim:replay names it: <run>_replay, then _replay_2, _replay_3, … */
export function nextReplayId(from: string, taken: Iterable<string>): string {
  const ids = new Set(taken);
  const base = `${from}_replay`;
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * The run "Replay run" replays from the one on screen: that run once it is done, else (a replay that
 * was stopped or failed) the finished run it replays, so the button still works there.
 */
export function replaySource(
  runId: string | null,
  runStatus: string | null,
  runs: readonly { runId: string; status: string }[],
): string | null {
  if (!runId) return null;
  if (runStatus === 'done') return runId;
  const base = /^(.+)_replay(?:_\d+)?$/.exec(runId)?.[1];
  return base && runs.some((r) => r.runId === base && r.status === 'done') ? base : null;
}

/** What sim:replay's output says so far: rounds finished, rounds planned, and its last word. */
export function replayProgress(lines: string[]): { roundsDone: number; roundsTotal: number | null; outcome: string | null } {
  let roundsTotal: number | null = null;
  let roundsDone = 0;
  let outcome: string | null = null;
  for (const line of lines) {
    const plan = /^replaying \S+ as \S+: (\d+) rounds/.exec(line.trim());
    if (plan) roundsTotal = Number(plan[1]);
    if (/^round \d+: /.test(line.trim())) roundsDone++;
    if (/^(identical to|NOT identical to)/.test(line.trim()) || /(Error|error:|refusing|no run |cache miss)/.test(line)) outcome = line.trim();
  }
  return { roundsDone, roundsTotal, outcome };
}

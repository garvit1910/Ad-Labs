import { setTimeout as sleep } from 'node:timers/promises';
import { sqlString, type Spacetime, type SqlRow } from '@/lib/adlab/spacetime-http';
import { checkA4Rows, readA4Tables } from '@/worker/creatives/check';
import type { ClientRows } from '@/worker/creatives/facts';
import { roundZeroStatusOf } from '@/worker/creatives/run';
import { isLaterRound, isLiveAd, isRoundZero, planSeed, readTargetState, type SeedTables } from './seed';

/*
 * The bench's verdicts, read straight from SpacetimeDB (never through the API under test):
 *   verifySeed: the database holds the seed and A5 can write on it (round 0 complete);
 *   verifyRun:  one run went end to end on the task board, B's worker and the creative writer
 *               taking turns, with the new copy simulated in the next round.
 */

export type Level = 'PASS' | 'WARN' | 'FAIL';

export class Report {
  readonly lines: Array<{ level: Level; text: string }> = [];
  pass(text: string) {
    this.lines.push({ level: 'PASS', text });
  }
  warn(text: string) {
    this.lines.push({ level: 'WARN', text });
  }
  fail(text: string) {
    this.lines.push({ level: 'FAIL', text });
  }
  check(ok: boolean, text: string, failText = text) {
    if (ok) this.pass(text);
    else this.fail(failText);
  }
  get failed() {
    return this.lines.some((line) => line.level === 'FAIL');
  }
  print(log: (line: string) => void = console.log) {
    for (const line of this.lines) log(`${line.level.padEnd(4)}  ${line.text}`);
  }
}

const json = (text: unknown): any => {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export interface VerifySeedOptions {
  /** The rows the seed meant to write; the target must match them exactly. */
  selection?: SeedTables;
  client: ClientRows;
  expectRound0: boolean;
}

export async function verifySeed(target: Spacetime, opts: VerifySeedOptions): Promise<Report> {
  const report = new Report();
  const state = await readTargetState(target);
  const creatives = state.creative;
  report.pass(
    `${target.label}: ${state.brand.length} brands, ${state.concept.length} concepts, ${state.segment.length} segments, ${state.arm.length} arms, ` +
      `${creatives.length} creatives (${creatives.filter((c) => c.origin === 'competitor_live').length} competitor_live, ` +
      `${creatives.filter((c) => c.origin === 'brand_live').length} brand_live, ${creatives.filter(isRoundZero).length} round 0), ${state.product.length} product(s)`,
  );
  if (opts.selection) {
    const plan = planSeed(opts.selection, state);
    const differs = (['brand', 'concept', 'segment', 'arm', 'product', 'creative'] as const)
      .filter((table) => plan.tables[table].write.length)
      .map((table) => `${table} ${plan.tables[table].added} new / ${plan.tables[table].changed} changed`);
    report.check(differs.length === 0, 'the target matches the source selection exactly', `the target differs from the source: ${differs.join(', ')}`);
    for (const warning of plan.warnings) report.warn(warning);
  }
  const later = creatives.filter(isLaterRound);
  if (later.length) report.warn(`${later.length} creative(s) from earlier runs are in the database; a new run would see them`);
  if (state.run.length) report.warn(`run(s) already here: ${state.run.map((r) => `${r.run_id} (${r.status})`).join(', ')}`);

  const tables = await readA4Tables(target);
  const check = checkA4Rows(tables, opts.client.rows);
  for (const failure of check.failures) report.fail(`A5 check: ${failure}`);
  if (!check.failures.length) report.pass(`A5 check passes; the longest state B can render is ${check.worstStateWords} words`);
  const round0 = roundZeroStatusOf(tables, opts.client.rows);
  if (opts.expectRound0) {
    report.check(round0.complete, `round 0 COMPLETE: ${round0.ranked.length} of ${round0.expected} ranked`, `round 0 incomplete: ${round0.problems.join('; ')}`);
  } else {
    report.check(!round0.complete, `round 0 incomplete, as seeded (${round0.missing.length} missing)`, 'round 0 is complete, but the seed left it out');
  }
  return report;
}

export interface RunState {
  run: SqlRow | null;
  rounds: SqlRow[];
  tasks: SqlRow[];
}

export async function readRunState(s: Spacetime, runId: string): Promise<RunState> {
  const [runs, rounds, tasks] = await Promise.all([
    s.sql(`SELECT * FROM run WHERE run_id = ${sqlString(runId)}`),
    s.sql(`SELECT * FROM round WHERE run_id = ${sqlString(runId)}`),
    s.sql(`SELECT * FROM task WHERE run_id = ${sqlString(runId)}`),
  ]);
  return {
    run: runs[0] ?? null,
    rounds: [...rounds].sort((a, b) => Number(a.round) - Number(b.round)),
    tasks: [...tasks].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
  };
}

/** The newest run in the database, by created_at. */
export async function latestRunId(s: Spacetime): Promise<string | null> {
  const runs = await s.sql('SELECT * FROM run');
  const newest = [...runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  return newest ? String(newest.run_id) : null;
}

export interface VerifyRunOptions {
  runId: string;
  /** Expected rounds_planned. */
  rounds?: number;
  /** Who must hold every generate_creatives task: creative_worker (A5's loop) or copywriter (A6). */
  claimer?: string;
  /** Poll until the run is done (or a task fails) for up to this many seconds. */
  waitSec?: number;
  /** Bounds on how long each generate_creatives task waited before its claim (seen while polling). */
  minClaimLatencySec?: number;
  maxClaimLatencySec?: number;
  log?: (line: string) => void;
}

const POLL_MS = 2_000;

export async function verifyRun(s: Spacetime, opts: VerifyRunOptions): Promise<Report> {
  const log = opts.log ?? (() => {});
  const claimSeen = new Map<string, number>();
  let state = await readRunState(s, opts.runId);
  if (opts.waitSec) {
    const deadline = Date.now() + opts.waitSec * 1000;
    let last = '';
    for (;;) {
      for (const task of state.tasks) {
        if (task.kind === 'generate_creatives' && task.status !== 'queued' && !claimSeen.has(String(task.task_id))) claimSeen.set(String(task.task_id), Date.now());
      }
      const failed = state.tasks.find((t) => t.status === 'failed');
      const done = state.run?.status === 'done';
      const summary = `run ${String(state.run?.status ?? 'missing')}; rounds done ${state.rounds.filter((r) => r.status === 'done').length}; tasks ${state.tasks.map((t) => `${String(t.task_id).replace(`_${opts.runId}`, '')}:${t.status}`).join(' ')}`;
      if (summary !== last) log(summary);
      last = summary;
      if (done || failed || Date.now() > deadline) break;
      await sleep(POLL_MS);
      state = await readRunState(s, opts.runId);
    }
  }

  const report = new Report();
  const { run, rounds, tasks } = state;
  if (!run) {
    report.fail(`R1 no run row for ${opts.runId}`);
    return report;
  }
  const planned = Number(run.rounds_planned);
  report.check(run.status === 'done', `R1 run ${opts.runId} is done`, `R1 run ${opts.runId} is ${String(run.status)}, not done`);
  if (opts.rounds !== undefined) report.check(planned === opts.rounds, `R1 rounds_planned ${planned}`, `R1 rounds_planned ${planned}, expected ${opts.rounds}`);

  const roundNumbers = Array.from({ length: planned + 1 }, (_, i) => i);
  const notDone = roundNumbers.filter((r) => rounds.find((row) => Number(row.round) === r)?.status !== 'done');
  report.check(notDone.length === 0, `R2 rounds 0..${planned} are done`, `R2 rounds not done: ${notDone.join(', ')}`);
  const empty = rounds.filter((row) => !(Number(json(row.summary)?.impressions) > 0)).map((row) => row.round);
  report.check(empty.length === 0, 'R2 every round summary has impressions', `R2 summaries without impressions: rounds ${empty.join(', ')}`);

  const task = (id: string) => tasks.find((t) => t.task_id === id);
  const runTask = (r: number) => task(`tsk_run_${opts.runId}_r${r}`);
  const genTask = (r: number) => task(`tsk_gen_${opts.runId}_r${r}`);
  const badRun = roundNumbers.filter((r) => runTask(r)?.status !== 'done' || !String(runTask(r)?.claimed_by ?? '').startsWith('sim-worker:'));
  report.check(badRun.length === 0, `R3 run_round tasks r0..r${planned} done by B's sim worker`, `R3 run_round tasks not done by the sim worker: r${badRun.join(', r')}`);
  const gens = roundNumbers.slice(0, -1);
  const badGen = gens.filter((r) => genTask(r)?.status !== 'done');
  report.check(badGen.length === 0, `R3 generate_creatives tasks r0..r${planned - 1} done`, `R3 generate_creatives tasks not done: r${badGen.join(', r')}`);
  report.check(!genTask(planned), `R3 no generate_creatives after the last round`, `R3 a generate_creatives task exists after the last round`);
  const failed = tasks.filter((t) => t.status === 'failed');
  report.check(failed.length === 0, 'R3 no task failed', `R3 failed: ${failed.map((t) => `${t.task_id} (${String(json(t.result)?.error ?? '').slice(0, 160)})`).join('; ')}`);

  const runCreatives = new Set<string>();
  let rankedTotal = 0;
  for (const r of gens) {
    const gen = genTask(r);
    if (!gen) continue;
    const result = json(gen.result) ?? {};
    for (const id of result.creative_ids ?? []) runCreatives.add(String(id));
    rankedTotal += Number(result.ranked ?? 0);
    const next = r + 1 <= planned ? `tsk_run_${opts.runId}_r${r + 1}` : null;
    report.check(
      Number(result.ranked) >= 1 && Number(result.round_created) === r + 1 && result.next_task === next,
      `R4 ${gen.task_id}: ${result.ranked} ranked, round_created ${result.round_created}, queued ${result.next_task}`,
      `R4 ${gen.task_id}: ranked ${result.ranked}, round_created ${result.round_created}, next ${result.next_task} (expected ≥1, ${r + 1}, ${next})`,
    );
    if (opts.claimer) report.check(gen.claimed_by === opts.claimer, `R4 ${gen.task_id} claimed by ${opts.claimer}`, `R4 ${gen.task_id} claimed by ${String(gen.claimed_by)}, not ${opts.claimer}`);
    const seen = claimSeen.get(String(gen.task_id));
    if (seen !== undefined && (opts.minClaimLatencySec !== undefined || opts.maxClaimLatencySec !== undefined)) {
      const latency = (seen - Date.parse(String(gen.created_at))) / 1000;
      const ok = latency >= (opts.minClaimLatencySec ?? 0) - POLL_MS / 1000 && latency <= (opts.maxClaimLatencySec ?? Infinity) + POLL_MS / 1000;
      report.check(ok, `R4 ${gen.task_id} claimed about ${latency.toFixed(0)} s after it was queued`, `R4 ${gen.task_id} claimed ${latency.toFixed(0)} s after it was queued (wanted ${opts.minClaimLatencySec ?? 0}–${opts.maxClaimLatencySec ?? '∞'} s)`);
    }
  }

  const generated = await s.sql(`SELECT * FROM creative WHERE origin = 'generated'`);
  const ours = generated.filter((c) => runCreatives.has(String(c.creative_id)));
  const ranked = ours.filter((c) => c.status === 'ranked').length;
  report.check(ours.length === runCreatives.size && ranked === rankedTotal, `R5 ${runCreatives.size} creative(s) written for this run, ${ranked} ranked`, `R5 ${ours.length} of ${runCreatives.size} creatives found, ${ranked} ranked vs ${rankedTotal} reported`);

  for (const r of roundNumbers.slice(1)) {
    const fresh = new Set(ours.filter((c) => Number(c.round_created) === r).map((c) => String(c.creative_id)));
    if (!fresh.size) continue;
    const decisions = await s.sql(`SELECT * FROM decision WHERE run_id = ${sqlString(opts.runId)} AND round = ${r}`);
    const shown = decisions.filter((d) => fresh.has(String(d.creative_id))).length;
    if (shown) report.pass(`R6 round ${r}: shoppers saw this run's new creatives ${shown} time(s)`);
    else report.warn(`R6 round ${r}: none of the ${fresh.size} new creative(s) was shown (the bandit may have picked other arms)`);
  }

  for (const r of gens) {
    const gen = genTask(r);
    const summary = json(rounds.find((row) => Number(row.round) === r)?.summary);
    if (!gen || !summary?.generation) continue;
    const arms = (x: any) => JSON.stringify([...(x?.arms ?? [])].map((a: any) => a.arm_id).sort());
    report.check(arms(summary.generation) === arms(json(gen.payload)), `R7 round ${r}'s generation request matches ${gen.task_id}`, `R7 round ${r}'s generation arms differ from ${gen.task_id}'s payload`);
  }

  const foreign = generated.filter((c) => isLaterRound(c) && !runCreatives.has(String(c.creative_id)));
  report.check(foreign.length === 0, 'R8 no other run\'s creatives were in the feeds', `R8 ${foreign.length} creative(s) from other runs share this database: ${foreign.slice(0, 3).map((c) => c.creative_id).join(', ')}`);
  return report;
}

export function liveAdCount(creatives: SqlRow[]): number {
  return creatives.filter(isLiveAd).length;
}

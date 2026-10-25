import { parseArgs } from 'node:util';
import { startRun } from '@/lib/adlab/runs';
import { connectSpacetime, resolveSpacetimeTarget, type SpacetimeTarget } from '@/lib/adlab/spacetime-http';
import { serviceSupabase } from '@/lib/adlab/supabase';
import { DEMO_DATABASE, DEMO_TARGET, LIVE_DATABASE, benchTarget, sameTarget, type BenchName } from '@/lib/adlab/targets';
import { loadClientRows } from '@/worker/creatives/facts';
import { errorMessage, table } from './phase';
import { applySeed, planSeed, readOnly, readSeedTables, readSnapshot, readTargetState, selectSeedRows, writeSnapshot, type SeedTables } from './bench/seed';
import { latestRunId, readRunState, verifyRun, verifySeed } from './bench/verify';

/*
 * The test bench (docs/PLAN.md "A6"): a seeded copy of the demo database's shared rows, so the
 * agents, A5 and B's worker can run end to end without touching B's demo run.
 *
 *   npm run bench -- snapshot                        read the demo database once into data/bench/source.json
 *   npm run bench -- seed --target local|live [--from-snapshot] [--without-round0] [--dry-run]
 *                                                    copy brands, concepts, segments, recipes, live ads, round 0
 *                                                    and the product row; writes only what changed
 *   npm run bench -- verify --target local|live [--no-source] [--without-round0]
 *   npm run bench -- start-run <run_id> --target local|live [--rounds N] [--population P] [--seed S]
 *   npm run bench -- verify-run <run_id>|--latest --target local|live [--rounds N] [--claimer creative_worker|copywriter]
 *                                                    [--wait SEC] [--min-claim-latency S] [--max-claim-latency S]
 *   npm run bench -- status [<run_id>] --target local|live
 *
 * Targets are always explicit (--target, or --target-uri with --target-db), never the SPACETIMEDB_* env,
 * and the demo database (adlab-calhacks13) is never a target. Reading Maincloud needs the network
 * outside Claude Code's sandbox; --from-snapshot keeps local resets offline.
 */

const SNAPSHOT = 'data/bench/source.json';
const log = (line: string) => console.log(`[bench] ${line}`);

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: 'string' },
    'target-uri': { type: 'string' },
    'target-db': { type: 'string' },
    'source-uri': { type: 'string' },
    'source-db': { type: 'string' },
    'allow-remote-target': { type: 'string' },
    'from-snapshot': { type: 'boolean', default: false },
    snapshot: { type: 'string', default: SNAPSHOT },
    'without-round0': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'no-source': { type: 'boolean', default: false },
    latest: { type: 'boolean', default: false },
    rounds: { type: 'string' },
    population: { type: 'string' },
    seed: { type: 'string' },
    claimer: { type: 'string' },
    wait: { type: 'string' },
    'min-claim-latency': { type: 'string' },
    'max-claim-latency': { type: 'string' },
  },
});
const [command, ...rest] = positionals;
const num = (value: string | undefined) => (value === undefined ? undefined : Number(value));

function targetFromArgs(): SpacetimeTarget {
  const target = args.target
    ? (() => {
        if (!['local', 'live'].includes(args.target!)) throw new Error(`--target must be local or live, not ${args.target}`);
        return benchTarget(args.target as BenchName);
      })()
    : args['target-uri'] && args['target-db']
      ? resolveSpacetimeTarget({ uri: args['target-uri'], dbName: args['target-db'] })
      : null;
  if (!target) throw new Error('give --target local|live, or --target-uri with --target-db');
  if (target.dbName === DEMO_DATABASE) throw new Error(`never write to ${DEMO_DATABASE}: it holds B's demo run`);
  if (!target.isLocal && target.dbName !== LIVE_DATABASE && args['allow-remote-target'] !== target.dbName) {
    throw new Error(`${target.label} is neither the local bench nor ${LIVE_DATABASE}; pass --allow-remote-target=${target.dbName} if you mean it`);
  }
  return target;
}

function sourceTarget(): SpacetimeTarget {
  return args['source-uri'] || args['source-db']
    ? resolveSpacetimeTarget({ uri: args['source-uri'], dbName: args['source-db'] })
    : resolveSpacetimeTarget(DEMO_TARGET);
}

async function sourceTables(target?: SpacetimeTarget): Promise<SeedTables> {
  if (args['from-snapshot']) {
    const snapshot = await readSnapshot(args.snapshot!);
    log(`source: ${snapshot.source}, snapshot taken ${snapshot.taken_at} (${args.snapshot})`);
    return snapshot.tables;
  }
  const source = sourceTarget();
  if (target && sameTarget(source, target)) throw new Error('the source and the target are the same database');
  log(`source: ${source.label} (read only)`);
  return readSeedTables(readOnly(await connectSpacetime(source)));
}

async function snapshot(): Promise<number> {
  const source = sourceTarget();
  log(`reading ${source.label} (read only)`);
  const tables = await readSeedTables(readOnly(await connectSpacetime(source)));
  await writeSnapshot(args.snapshot!, { taken_at: new Date().toISOString(), source: source.label, tables });
  log(`wrote ${args.snapshot}: ${Object.entries(tables).map(([t, rows]) => `${rows.length} ${t}`).join(', ')}`);
  return 0;
}

async function seed(): Promise<number> {
  const target = targetFromArgs();
  log(`target: ${target.label}`);
  const selection = selectSeedRows(await sourceTables(target), { withoutRound0: args['without-round0'] });
  if (selection.problems.length) {
    for (const problem of selection.problems) log(`refused: ${problem}`);
    return 1;
  }
  if (selection.skippedCreatives.length) log(`skipping ${selection.skippedCreatives.length} creative(s) from other runs, e.g. ${selection.skippedCreatives.slice(0, 3).join(', ')}`);
  if (selection.skippedProducts.length) log(`skipping products of unknown brands: ${selection.skippedProducts.join(', ')}`);
  const spacetime = await connectSpacetime(target);
  const plan = planSeed(selection.rows, await readTargetState(spacetime));
  table(
    Object.entries(plan.tables).map(([name, t]) => ({ table: name, new: t.added, changed: t.changed, unchanged: t.unchanged, extra: t.extra.length })),
  );
  for (const warning of plan.warnings) log(`warning: ${warning}`);
  if (plan.refusals.length) {
    for (const refusal of plan.refusals) log(`refused: ${refusal}`);
    return 1;
  }
  if (args['dry-run']) {
    log(`dry run: would write ${plan.writes} row(s)`);
    return 0;
  }
  const calls = await applySeed(spacetime, plan, log);
  log(`${calls} reducer call(s), ${plan.writes} row(s) written`);
  return verify(target, selection.rows);
}

async function verify(target = targetFromArgs(), selection?: SeedTables): Promise<number> {
  const spacetime = await connectSpacetime(target);
  const client = await loadClientRows(serviceSupabase());
  const wanted = selection ?? (args['no-source'] ? undefined : selectSeedRows(await sourceTables(target), { withoutRound0: args['without-round0'] }).rows);
  const report = await verifySeed(spacetime, { selection: wanted, client, expectRound0: !args['without-round0'] });
  report.print();
  return report.failed ? 1 : 0;
}

async function startRunCommand(): Promise<number> {
  const runId = rest[0];
  if (!runId) throw new Error('usage: npm run bench -- start-run <run_id> --target local|live [--rounds N]');
  const spacetime = await connectSpacetime(targetFromArgs());
  log(`target: ${spacetime.label}`);
  const result = await startRun(spacetime, {
    runId,
    roundsPlanned: num(args.rounds),
    population: num(args.population),
    seed: num(args.seed),
    requestedBy: 'user',
  });
  log(`queued ${result.task_id}: ${result.rounds_planned} round(s) after the warm-up, ${result.population} shoppers, seed ${result.seed}`);
  return 0;
}

async function verifyRunCommand(): Promise<number> {
  const spacetime = await connectSpacetime(targetFromArgs());
  const runId = args.latest ? await latestRunId(spacetime) : rest[0];
  if (!runId) throw new Error('usage: npm run bench -- verify-run <run_id>|--latest --target local|live');
  log(`verifying ${runId} on ${spacetime.label}`);
  const report = await verifyRun(spacetime, {
    runId,
    rounds: num(args.rounds),
    claimer: args.claimer,
    waitSec: num(args.wait),
    minClaimLatencySec: num(args['min-claim-latency']),
    maxClaimLatencySec: num(args['max-claim-latency']),
    log,
  });
  report.print();
  return report.failed ? 1 : 0;
}

async function status(): Promise<number> {
  const spacetime = await connectSpacetime(targetFromArgs());
  log(spacetime.label);
  const runId = rest[0] ?? (await latestRunId(spacetime));
  if (!runId) {
    log('no runs yet');
    return 0;
  }
  const { run, rounds, tasks } = await readRunState(spacetime, runId);
  log(`run ${runId}: ${run ? `${String(run.status)}, ${String(run.rounds_planned)} round(s) planned, ${String(run.population)} shoppers` : 'no run row'}`);
  table(rounds.map((r) => ({ round: r.round, status: r.status, started: r.started_at, finished: r.finished_at })));
  table(tasks.map((t) => ({ task: t.task_id, status: t.status, claimed_by: t.claimed_by, updated: t.updated_at })));
  return 0;
}

const COMMANDS: Record<string, () => Promise<number>> = {
  snapshot,
  seed,
  verify: () => verify(),
  'start-run': startRunCommand,
  'verify-run': verifyRunCommand,
  status,
};

const run = COMMANDS[command ?? ''];
if (!run) {
  console.error(`usage: npm run bench -- <${Object.keys(COMMANDS).join(' | ')}>`);
  process.exit(2);
}
try {
  process.exitCode = await run();
} catch (error) {
  console.error(`[bench] failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}

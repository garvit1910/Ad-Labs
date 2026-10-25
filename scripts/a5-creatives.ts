import { writeFileSync } from 'node:fs';
import { connectSpacetime } from '@/lib/adlab/spacetime-http';
import { serviceSupabase } from '@/lib/adlab/supabase';
import { checkA4Rows, readA4Tables } from '@/worker/creatives/check';
import { loadClientRows } from '@/worker/creatives/facts';
import { NotReadyError, spacetimeInputs, standInInputs, type InputSource } from '@/worker/creatives/inputs';
import { runCreativeTaskLoop } from '@/worker/creatives/loop';
import { planPairs } from '@/worker/creatives/pairs';
import {
  CREATIVE_WORKER,
  generateCreatives,
  roundZeroStatus,
  runGenerateCreatives,
  runRound0,
  skipLine,
  type RoundZeroStatus,
  type WrittenCreative,
} from '@/worker/creatives/run';
import { runFixtureSmoke } from '@/worker/creatives/smoke';
import { errorMessage, table } from './phase';

/*
 * A5: the text-only creative worker (docs/PLAN.md "A5").
 *
 *   npm run a5:creatives -- smoke          Adcero's creative fixture, model mocked, diffed against creative-output.json
 *   npm run a5:creatives -- dry [--source=standin|spacetime] [--out=<file>]
 *                                          the whole sequence on A3's live facts; prints the creatives, writes nothing
 *   npm run a5:creatives -- check          whether A4's rows have landed and are usable; exits 1 while not
 *   npm run a5:creatives -- round0 [--regenerate] [--force]
 *                                          the check, then round 0: one creative per (recipe, segment), round_created 0.
 *                                          Writes only what's missing or gated out; refuses once B has started a run
 *   npm run a5:creatives -- round0-status  whether round 0 is completely written; exits 0 only when B can queue round 0
 *   npm run a5:creatives -- task <id> [--takeover]
 *                                          one generate_creatives task, now
 *   npm run a5:creatives -- worker         the task-board loop: claims generate_creatives tasks left unclaimed for 60s
 *
 * The npm script sets NODE_ENV=production and CREATIVE_JUDGE_GATE_MODE=off (CREATIVE_MANIFEST §3, §6.1).
 */

// Every copy call (retries included) goes through fetch; Adcero prices one at 2¢ (CREATIVE_BRAND_COPY_COST_CENTS).
const COPY_CALL_CENTS = 2;
let copyCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith('/chat/completions')) copyCalls++;
  return realFetch(url, init);
}) as typeof fetch;
const cost = () => `${copyCalls} gpt-4o call(s), about $${((copyCalls * COPY_CALL_CENTS) / 100).toFixed(2)}`;

const log = (line: string) => console.log(`[a5] ${line}`);
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name: string) => rest.includes(`--${name}`);

function printCreatives(creatives: WrittenCreative[]): void {
  table(
    creatives.map((creative) => ({
      creative_id: creative.row.creative_id,
      status: creative.status,
      copy: creative.copySource,
      headline: creative.headline,
    })),
  );
  for (const creative of creatives) {
    console.log(`\n${creative.row.creative_id}  ${creative.status}`);
    console.log(`  headline  ${creative.headline}`);
    console.log(`  primary   ${creative.primaryText}`);
    console.log(`  cta       ${creative.cta}`);
    console.log(`  visual    ${creative.visualDescription} (${creative.visualDescriptionSource})`);
    if (creative.statusReason) console.log(`  gated     ${creative.statusReason}`);
  }
}

function summarize(creatives: WrittenCreative[], expected: number): void {
  const ranked = creatives.filter((creative) => creative.status === 'ranked').length;
  log(`${creatives.length} of ${expected} expected creatives: ${ranked} ranked, ${creatives.length - ranked} gated out; ${cost()}`);
}

async function smoke(): Promise<number> {
  const { mismatches, creatives, calls } = await runFixtureSmoke();
  for (const mismatch of mismatches) log(`MISMATCH ${mismatch}`);
  log(`fixture diff: ${creatives.length} creatives from ${calls} mocked copy calls, ${mismatches.length} mismatch(es)`);
  return mismatches.length === 0 ? 0 : 1;
}

async function dry(): Promise<number> {
  const source = (flag('source') ?? 'standin') as InputSource;
  if (source !== 'standin' && source !== 'spacetime') throw new Error(`--source must be standin or spacetime, not ${source}`);
  const client = await loadClientRows(serviceSupabase());
  log(`${client.rows.length} compiler rows from the live facts (${client.dropped} competitor facts dropped)`);
  const inputs = source === 'standin' ? standInInputs(client.rows) : await spacetimeInputs(await connectSpacetime(), client.rows);
  for (const warning of inputs.warnings) log(`warning: ${warning}`);
  const segmentIds = inputs.segments.map((segment) => segment.segment_id);
  const { pairs, skips } = planPairs(inputs.recipes, segmentIds, client.rows);
  for (const skip of skips) log(skipLine(skip));
  log(`dry run on ${source} rows: ${inputs.recipes.length} recipes × ${segmentIds.length} segments − ${skips.length} skips`);
  const { creatives, errors } = await generateCreatives({
    inputs,
    rows: client.rows,
    brandProfileId: client.brandProfileId,
    pairs,
    roundCreated: 0,
    runId: '',
    variants: 1,
  });
  printCreatives(creatives);
  for (const error of errors) log(`ERROR ${error}`);
  summarize(creatives, inputs.recipes.length * segmentIds.length - skips.length);
  const out = flag('out');
  if (out) {
    writeFileSync(out, `${JSON.stringify({ source, skips, errors, creatives }, null, 2)}\n`);
    log(`wrote ${out}`);
  }
  return errors.length === 0 ? 0 : 1;
}

async function check(): Promise<number> {
  const spacetime = await connectSpacetime();
  const [tables, client] = await Promise.all([readA4Tables(spacetime), loadClientRows(serviceSupabase())]);
  const brandLive = tables.creatives.filter((creative) => creative.origin === 'brand_live').length;
  const generated = tables.creatives.filter((creative) => creative.origin === 'generated').length;
  log(
    `${spacetime.label}: ${tables.brands.length} brands, ${tables.segments.length} segments, ${tables.arms.length} arms, ` +
      `${brandLive} brand_live and ${generated} generated creatives, ${tables.products.length} products`,
  );
  const result = checkA4Rows(tables, client.rows);
  for (const warning of result.warnings) log(`warning: ${warning}`);
  for (const skip of result.skips) log(skipLine(skip));
  if (result.failures.length > 0) {
    for (const failure of result.failures) log(`not yet: ${failure}`);
    log(`NOT YET: ${result.failures.length} problem(s) with A4's rows`);
    return 1;
  }
  log(
    `READY: ${result.brand!.brand_id}, ${result.segments.length} segments, ${result.recipes.length} recipes + ${result.controlArmId}, ` +
      `landing on ${result.landingProductId}; round 0 writes ${result.expected} creatives (${result.skips.length} logged skips); ` +
      `worst-case Jev state ${result.worstStateWords} words`,
  );
  return 0;
}

function printStatus(status: RoundZeroStatus): void {
  log(`round 0: ${status.ranked.length} ranked, ${status.gatedOut.length} gated out, ${status.missing.length} missing of ${status.expected}`);
  for (const id of status.gatedOut) log(`  gated out: ${id}`);
  for (const problem of status.problems) log(`  not yet: ${problem}`);
  log(status.complete ? 'ROUND 0 COMPLETE: safe to queue round 0 (B: sim:worker -- --enqueue <run_id>)' : 'ROUND 0 NOT COMPLETE: do not queue round 0 yet');
}

async function round0Status(): Promise<number> {
  const status = await roundZeroStatus();
  printStatus(status);
  return status.complete ? 0 : 1;
}

async function round0(): Promise<number> {
  try {
    const report = await runRound0({ log, regenerate: has('regenerate'), force: has('force') });
    printCreatives(report.creatives);
    for (const error of report.errors) log(`ERROR ${error}`);
    summarize(report.creatives, report.expected - report.kept);
    log(`round 0 written: ${report.written} creative rows, ${report.kept} kept (${report.skips.length} logged skips)`);
    printStatus(report.status);
    return report.status.complete ? 0 : 1;
  } catch (error) {
    if (!(error instanceof NotReadyError)) throw error;
    for (const failure of error.failures) log(`not yet: ${failure}`);
    log('round 0 not written: A4 rows not ready');
    return 1;
  }
}

async function task(): Promise<number> {
  const taskId = rest[0];
  if (!taskId) throw new Error('usage: npm run a5:creatives -- task <task_id>');
  const result = await runGenerateCreatives(taskId, { claimedBy: CREATIVE_WORKER, takeover: has('takeover') });
  console.log(JSON.stringify(result, null, 2));
  log(cost());
  return 0;
}

async function worker(): Promise<number> {
  const shutdown = new AbortController();
  process.once('SIGINT', () => {
    log('stopping after the current task (Ctrl-C again to force)');
    shutdown.abort();
    process.once('SIGINT', () => process.exit(130));
  });
  await runCreativeTaskLoop({ signal: shutdown.signal });
  log(cost());
  return 0;
}

const COMMANDS: Record<string, () => Promise<number>> = { smoke, dry, check, round0, 'round0-status': round0Status, task, worker };

const run = COMMANDS[command ?? ''];
if (!run) {
  console.error(`usage: npm run a5:creatives -- <${Object.keys(COMMANDS).join(' | ')}>`);
  process.exit(2);
}
try {
  process.exitCode = await run();
} catch (error) {
  console.error(`[a5] failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}

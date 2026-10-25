import { buildContractRows, loadFacts, personaInfo } from './a4/build';
import { type BrandRow, type ConceptRow, type ProductRow, type World, checkWorld, printCheck } from './a4/check';
import type { ArmRow } from './a4/arms';
import type { CreativeRow } from './a4/live-ads';
import { createLlm } from './a4/llm';
import type { SegmentRow } from './a4/segments';
import { factHints } from './a4/vocabulary';
import { createPhase, errorMessage, table } from './phase';
import { type Spacetime, connectSpacetime } from '@/lib/adlab/spacetime-http';

/*
 * Ad Lab A4: A's contract rows in SpacetimeDB (docs/PLAN.md "A4" and "Hand-off to A5").
 *
 *   npm run a4:rows -- --dry-run   build every row and check it; write nothing
 *   npm run a4:rows                build, upsert brand → concept → segment → arm → creative, then check
 *   npm run a4:rows -- check       read-only check of what SpacetimeDB holds
 *
 *   --refresh      ask the LLM again instead of reusing data/a4/llm-cache.json
 *   --force-arms   write an arm set that differs from the one already in SpacetimeDB
 *   --keep-arms    reuse the recipes already in SpacetimeDB as they are (rewrite only segments and creatives)
 *   --as-of=<ISO>  compute live-ad longevity at this time instead of the last scrape
 *   --allow-during-runs   write even though B has a run (a run in progress then reads the new rows)
 *
 * Upserts only, by deterministic ids. reset_a_tables is never called: it would also
 * clear A5's generated creatives.
 */

const args = process.argv.slice(2);
const mode = args.includes('check') ? 'check' : args.includes('--dry-run') ? 'dry-run' : 'write';
const asOf = args.find((arg) => arg.startsWith('--as-of='))?.slice('--as-of='.length);
const CREATIVE_CHUNK = 50;

const { db, log } = createPhase('a4');

const clip = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function readWorld(spacetime: Spacetime): Promise<World> {
  const [brands, concepts, segments, arms, creatives, products] = await Promise.all([
    spacetime.sql<BrandRow>('SELECT * FROM brand'),
    spacetime.sql<ConceptRow>('SELECT * FROM concept'),
    spacetime.sql<SegmentRow>('SELECT * FROM segment'),
    spacetime.sql<ArmRow>('SELECT * FROM arm'),
    spacetime.sql<CreativeRow>('SELECT * FROM creative'),
    spacetime.sql<ProductRow>('SELECT * FROM product'),
  ]);
  return { brands, concepts, segments, arms, creatives, products };
}

/** How many of `next` are new, changed or unchanged against what SpacetimeDB holds. */
function diff<T extends object>(current: T[], next: T[], id: keyof T): string {
  const before = new Map(current.map((row) => [String(row[id]), JSON.stringify(row)]));
  let added = 0;
  let changed = 0;
  for (const row of next) {
    const old = before.get(String(row[id]));
    if (old === undefined) added++;
    else if (old !== JSON.stringify(row)) changed++;
  }
  return `${next.length} rows: ${added} new, ${changed} changed, ${next.length - added - changed} unchanged`;
}

async function check(): Promise<void> {
  const spacetime = await connectSpacetime();
  const { facts } = await loadFacts(db);
  const world = await readWorld(spacetime);
  const result = checkWorld(world, personaInfo(facts), factHints(facts).hints);
  printCheck(`A4 check: what ${spacetime.label} holds`, result);
  if (result.failed) process.exitCode = 1;
}

async function build(): Promise<void> {
  const spacetime = await connectSpacetime();
  const llm = createLlm({ refresh: args.includes('--refresh') });
  const keepArms = args.includes('--keep-arms') ? await spacetime.sql<ArmRow>('SELECT * FROM arm') : undefined;
  if (keepArms && keepArms.length === 0) throw new Error('--keep-arms: SpacetimeDB has no arm rows to keep');
  const rows = await buildContractRows({ db, spacetime, llm, log, ...(keepArms ? { keepArms } : {}), ...(asOf ? { asOf } : {}) });
  const { world } = rows;

  console.log('\nsegments');
  table(
    rows.segments.map(({ row, vocFrequency, quotes, weights }) => ({
      segment_id: row.segment_id,
      name: row.name,
      share: row.share.toFixed(3),
      voc_freq: vocFrequency,
      quotes: quotes.length,
      in_market: row.in_market_rate,
      cares_a_lot: Object.entries(weights).filter(([, w]) => w >= 0.7).sort((a, b) => b[1] - a[1]).map(([key, w]) => `${key} ${w}`).join(', '),
    })),
  );
  for (const segment of rows.segments) {
    console.log(`\n${segment.row.segment_id}: ${segment.row.description}`);
    for (const quote of segment.quotes) console.log(`  "${clip(quote, 160)}"`);
    for (const drop of segment.dropped) console.log(`  dropped ${drop}`);
  }

  console.log('\nrecipes');
  table(
    rows.arms.map(({ row, evidenceIds, basis }) => ({
      arm_id: row.arm_id,
      strategy: row.strategy,
      evidence: evidenceIds.length,
      basis: clip(basis, 110),
    })),
  );
  for (const { row, requirement } of rows.arms) {
    console.log(`\n${row.arm_id} [${row.strategy}]: ${row.rationale}`);
    if (requirement) console.log(`  backed by ${requirement}`);
  }

  console.log('\nlive ads → creatives');
  table([...rows.live.counts].map(([brand_id, count]) => ({ brand_id, ads: count.ads, with_body: count.withBody, rows: count.rows })));
  console.log(`landing product for brand_live: ${rows.landingProductId}`);
  const usage = llm.stats();
  console.log(`LLM (${usage.model}): ${usage.calls} call(s), ${usage.cached} from cache`);

  const local = checkWorld(world, rows.personas, rows.hints.hints);
  printCheck('A4 check: the rows as built', local);
  if (local.failed) {
    process.exitCode = 1;
    log('local check failed: nothing written');
    return;
  }
  if (mode === 'dry-run') {
    log('dry run: nothing written');
    return;
  }

  const current = await readWorld(spacetime);
  const currentArms = new Set(current.arms.map((arm) => arm.arm_id));
  const nextArms = new Set(world.arms.map((arm) => arm.arm_id));
  const dropped = [...currentArms].filter((id) => !nextArms.has(id));
  const added = [...nextArms].filter((id) => !currentArms.has(id));
  if (currentArms.size > 0 && (dropped.length || added.length) && !args.includes('--force-arms')) {
    // Upserts never delete, so a changed set would leave the old recipes behind, and A5 may have written against them.
    log(`the arm set differs from SpacetimeDB's (would add ${added.join(', ') || 'none'}; would leave behind ${dropped.join(', ') || 'none'})`);
    log('agree the change with A5, then rerun with --force-arms. Nothing written');
    process.exitCode = 1;
    return;
  }
  const runs = await spacetime.sql('SELECT * FROM run');
  const segmentDiff = diff(current.segments, world.segments, 'segment_id');
  const creativeDiff = diff(current.creatives, world.creatives, 'creative_id');
  const unchanged = (text: string, n: number) => text.endsWith(`${n} unchanged`);
  if (runs.length > 0 && !(unchanged(segmentDiff, world.segments.length) && unchanged(creativeDiff, world.creatives.length))) {
    // B's run (and its cached replay) read these rows; rewriting them mid-run changes what it simulates.
    log(`B has ${runs.length} run(s) and the rows change (segments: ${segmentDiff}; creatives: ${creativeDiff})`);
    if (!args.includes('--allow-during-runs')) {
      log('agree the change with B, then rerun with --allow-during-runs. Nothing written');
      process.exitCode = 1;
      return;
    }
  }

  const steps: Array<[string, object[], number]> = [
    ['upsert_brands', world.brands, world.brands.length],
    ['upsert_concepts', world.concepts, world.concepts.length],
    ['upsert_segments', world.segments, world.segments.length],
    ['upsert_arms', world.arms, world.arms.length],
    ['upsert_creatives', world.creatives, CREATIVE_CHUNK],
  ];
  const diffs: Record<string, string> = {
    upsert_brands: diff(current.brands, world.brands, 'brand_id'),
    upsert_concepts: diff(current.concepts, world.concepts, 'concept_id'),
    upsert_segments: segmentDiff,
    upsert_arms: diff(current.arms, world.arms, 'arm_id'),
    upsert_creatives: creativeDiff,
  };
  for (const [reducer, batch, chunk] of steps) {
    for (let i = 0; i < batch.length; i += chunk) await spacetime.call(reducer, [batch.slice(i, i + chunk)]);
    log(`${reducer}: ${diffs[reducer]}`);
  }

  const written = checkWorld(await readWorld(spacetime), rows.personas, rows.hints.hints);
  printCheck(`A4 check: what ${spacetime.label} holds`, written);
  if (written.failed) process.exitCode = 1;
}

try {
  await (mode === 'check' ? check() : build());
} catch (error) {
  console.error(`[a4] ${mode} failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}

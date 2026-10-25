import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Spacetime, SqlRow } from '@/lib/adlab/spacetime-http';

/*
 * Seeding a bench database (the local bench, or the stage database) with a copy of the scraped
 * data: A's rows and B's product row as they are on the demo database. Only what every run
 * shares is copied: brands, concepts, segments, recipes, the live ads and round 0's generated
 * creatives. Another run's later creatives never are, because the creative table has no run
 * column and B's loader reads every creative in the database.
 */

export const SEED_TABLES = ['brand', 'concept', 'segment', 'arm', 'product', 'creative'] as const;
export type SeedTable = (typeof SEED_TABLES)[number];
export type SeedTables = Record<SeedTable, SqlRow[]>;

export const KEY: Record<SeedTable, string> = {
  brand: 'brand_id',
  concept: 'concept_id',
  segment: 'segment_id',
  arm: 'arm_id',
  product: 'product_id',
  creative: 'creative_id',
};

/** Same chunk as A4's writer (scripts/a4-build-rows.ts). */
export const CREATIVE_CHUNK = 50;

export interface TargetState extends SeedTables {
  run: SqlRow[];
  task: SqlRow[];
}

export const isLiveAd = (c: SqlRow) => c.origin === 'competitor_live' || c.origin === 'brand_live';
/** Round 0 (cr_g0_…), shared by every run. */
export const isRoundZero = (c: SqlRow) => c.origin === 'generated' && Number(c.round_created) === 0 && /^cr_g0_[a-z0-9_]+$/.test(String(c.creative_id));
/** A generated creative some run wrote after round 0. */
export const isLaterRound = (c: SqlRow) => c.origin === 'generated' && Number(c.round_created) >= 1;

export interface Selection {
  rows: SeedTables;
  skippedCreatives: string[];
  skippedProducts: string[];
  problems: string[];
}

export function selectSeedRows(source: SeedTables, opts: { withoutRound0?: boolean } = {}): Selection {
  const brands = new Set(source.brand.map((b) => String(b.brand_id)));
  const keep = (c: SqlRow) => isLiveAd(c) || (!opts.withoutRound0 && isRoundZero(c));
  const creatives = source.creative.filter(keep);
  const products = source.product.filter((p) => brands.has(String(p.brand_id)));
  const client = source.brand.filter((b) => b.is_client === true);
  const problems: string[] = [];
  if (client.length !== 1) problems.push(`the source has ${client.length} client brands, not 1`);
  if (!creatives.some((c) => c.origin === 'brand_live')) problems.push('the source has no brand_live creative (A4 has not finished)');
  if (!opts.withoutRound0 && !creatives.some(isRoundZero)) problems.push('the source has no round-0 creative (run `npm run a5:creatives -- round0` there first)');
  if (client.length === 1 && !products.some((p) => p.brand_id === client[0]!.brand_id)) problems.push('the source has no product for the client brand');
  return {
    rows: { ...source, creative: creatives, product: products },
    skippedCreatives: source.creative.filter((c) => !keep(c)).map((c) => String(c.creative_id)),
    skippedProducts: source.product.filter((p) => !brands.has(String(p.brand_id))).map((p) => String(p.product_id)),
    problems,
  };
}

export interface TablePlan {
  write: SqlRow[];
  added: number;
  changed: number;
  unchanged: number;
  /** Ids on the target that the selection doesn't have. */
  extra: string[];
}

export interface SeedPlan {
  tables: Record<SeedTable, TablePlan>;
  refusals: string[];
  warnings: string[];
  /** Rows to write across all tables. */
  writes: number;
}

const same = (a: SqlRow, b: SqlRow) => JSON.stringify(a) === JSON.stringify(b);

export function planSeed(selected: SeedTables, target: TargetState): SeedPlan {
  const tables = {} as Record<SeedTable, TablePlan>;
  for (const table of SEED_TABLES) {
    const key = KEY[table];
    const existing = new Map(target[table].map((row) => [String(row[key]), row]));
    const wanted = new Set(selected[table].map((row) => String(row[key])));
    const plan: TablePlan = { write: [], added: 0, changed: 0, unchanged: 0, extra: [] };
    for (const row of selected[table]) {
      const old = existing.get(String(row[key]));
      if (!old) plan.added++;
      else if (!same(old, row)) plan.changed++;
      else {
        plan.unchanged++;
        continue;
      }
      plan.write.push(row);
    }
    plan.extra = [...existing.keys()].filter((id) => !wanted.has(id));
    tables[table] = plan;
  }

  const refusals: string[] = [];
  const warnings: string[] = [];
  for (const table of ['brand', 'concept', 'segment', 'arm'] as const) {
    if (tables[table].extra.length) refusals.push(`the target holds ${table} rows the source doesn't (${tables[table].extra.slice(0, 5).join(', ')}); reset it first`);
  }
  const targetCreatives = new Map(target.creative.map((c) => [String(c.creative_id), c]));
  const foreign = tables.creative.extra.filter((id) => isLaterRound(targetCreatives.get(id)!));
  const strange = tables.creative.extra.filter((id) => !isLaterRound(targetCreatives.get(id)!));
  if (strange.length) refusals.push(`the target holds creatives the source doesn't (${strange.slice(0, 5).join(', ')}); reset it first`);
  if (foreign.length) warnings.push(`the target holds ${foreign.length} creative(s) from earlier runs; a new run there would see them, so reset it for a clean run`);
  const seededBrands = new Set(selected.brand.map((b) => String(b.brand_id)));
  const strayProducts = target.product.filter((p) => !seededBrands.has(String(p.brand_id))).map((p) => String(p.product_id));
  if (strayProducts.length) refusals.push(`the target holds products of unknown brands (${strayProducts.join(', ')}), which B's loader rejects; reset it first`);

  const writes = SEED_TABLES.reduce((sum, table) => sum + tables[table].write.length, 0);
  const runRounds = target.task.filter((t) => t.kind === 'run_round');
  if (target.run.length || runRounds.length) {
    const runs = [...new Set([...target.run.map((r) => String(r.run_id)), ...runRounds.map((t) => String(t.run_id))])];
    if (writes) refusals.push(`the target has run(s) ${runs.join(', ')} that simulated its current rows; reset it before seeding`);
    else warnings.push(`the target already has run(s) ${runs.join(', ')}`);
  }
  return { tables, refusals, warnings, writes };
}

async function readAll(s: Spacetime, tables: readonly string[]): Promise<Record<string, SqlRow[]>> {
  const entries = await Promise.all(
    tables.map(async (table) => {
      try {
        return [table, await s.sql(`SELECT * FROM ${table}`)] as const;
      } catch (err) {
        throw new Error(`can't read ${table} on ${s.label} (publish the module there first?): ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  return Object.fromEntries(entries);
}

export const readSeedTables = async (s: Spacetime) => (await readAll(s, SEED_TABLES)) as unknown as SeedTables;
export const readTargetState = async (s: Spacetime) => (await readAll(s, [...SEED_TABLES, 'run', 'task'])) as unknown as TargetState;

/** Writes the plan's rows; returns the number of reducer calls made (0 when nothing changed). */
export async function applySeed(target: Spacetime, plan: SeedPlan, log: (line: string) => void): Promise<number> {
  let calls = 0;
  const call = async (reducer: string, args: unknown[], what: string) => {
    await target.call(reducer, args);
    calls++;
    log(`${reducer}: ${what}`);
  };
  for (const [table, reducer] of [
    ['brand', 'upsert_brands'],
    ['concept', 'upsert_concepts'],
    ['segment', 'upsert_segments'],
    ['arm', 'upsert_arms'],
  ] as const) {
    const rows = plan.tables[table].write;
    if (rows.length) await call(reducer, [rows], `${rows.length} row(s)`);
  }
  const products = plan.tables.product.write;
  if (products.length) await call('upsert_products', [JSON.stringify(products)], `${products.length} row(s)`);
  // brand_live last: A5's readiness check reads "the control arm has a brand_live creative" as "the writer finished".
  const creatives = plan.tables.creative.write;
  const ordered = [
    ...creatives.filter((c) => c.origin === 'competitor_live'),
    ...creatives.filter((c) => c.origin === 'generated'),
    ...creatives.filter((c) => c.origin === 'brand_live'),
  ];
  for (let i = 0; i < ordered.length; i += CREATIVE_CHUNK) {
    const chunk = ordered.slice(i, i + CREATIVE_CHUNK);
    await call('upsert_creatives', [chunk], `${chunk.length} row(s)`);
  }
  return calls;
}

/** The source is only ever read. */
export function readOnly(s: Spacetime): Spacetime {
  return {
    label: s.label,
    target: s.target,
    sql: (query) => s.sql(query),
    call: async (reducer) => {
      throw new Error(`the seed source ${s.label} is read-only (tried ${reducer})`);
    },
  };
}

export interface Snapshot {
  taken_at: string;
  source: string;
  tables: SeedTables;
}

export async function writeSnapshot(path: string, snapshot: Snapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 1)}\n`);
}

export async function readSnapshot(path: string): Promise<Snapshot> {
  return JSON.parse(await readFile(path, 'utf8')) as Snapshot;
}

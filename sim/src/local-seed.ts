import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnv } from "./config.js";
import { loadWorld } from "./fixtures.js";
import { type Db, SpacetimeHttp, isLocalUri } from "./spacetime.js";

// The test bench's stand-in for A4: loads A's tables into a LOCAL SpacetimeDB through A's own
// upsert reducers, in A's conventions (tables_a.ts: "" for empty, json columns as JSON strings).
//   - default: the fixture world (the conversion is the module test's, test/module/module.test.ts);
//     products are B's table and the worker writes them in --fixtures mode.
//   - --from-maincloud: A's real rows and the product row, read from Maincloud with SQL only, so
//     the sim can run on real data without touching the shared database.
//
// Usage: SPACETIMEDB_URI=http://127.0.0.1:3100 SPACETIMEDB_DB_NAME=adlab-local npm run sim:local-seed [-- --from-maincloud]
// It refuses any server that isn't localhost, so it can never write A's tables on Maincloud.

const MAINCLOUD = { uri: "https://maincloud.spacetimedb.com", db: "adlab-calhacks13" };
// Load order matters: A's reducers check references backwards (brand → concept → segment → arm → creative).
const A_TABLES = [
  ["brand", "upsert_brands"],
  ["concept", "upsert_concepts"],
  ["segment", "upsert_segments"],
  ["arm", "upsert_arms"],
  ["creative", "upsert_creatives"],
] as const;

function fixtureBatches(): [string, object[]][] {
  const w = loadWorld();
  const e = (v: unknown) => (v === null || v === undefined ? "" : v);
  const j = (v: unknown) => JSON.stringify(v);
  return [
    ["upsert_brands", w.brands],
    ["upsert_concepts", w.concepts],
    ["upsert_segments", w.segments.map((s) => ({ ...s, prior_weights: j(s.prior_weights), quotes: j(s.quotes) }))],
    ["upsert_arms", w.arms.map((a) => ({ ...a, angle: e(a.angle), hook: e(a.hook), evidence: j(a.evidence) }))],
    [
      "upsert_creatives",
      w.creatives.map((c) => ({
        ...c,
        arm_id: e(c.arm_id),
        image_url: e(c.image_url),
        landing_product_id: e(c.landing_product_id),
        segment_id: e(c.segment_id),
        pack_fingerprint: e(c.pack_fingerprint),
        learning_ids: j(c.learning_ids),
      })),
    ],
  ];
}

// Copies A's five tables and the product rows from one database to another. A's rows come back
// from SQL already in A's conventions (json columns as text, no option columns), so they go back
// in as they are. Refuses a target that already holds another world's brands, so fixture and real
// rows never mix in one database.
export async function mirrorWorld(source: Db, target: Db): Promise<Record<string, number>> {
  const read = Object.fromEntries(
    await Promise.all([...A_TABLES.map(([t]) => t), "product"].map(async (t) => [t, await source.sql(`SELECT * FROM ${t}`)] as const)),
  );
  const brands = new Set(read.brand!.map((b) => String(b.brand_id)));
  const foreign = (await target.sql("SELECT * FROM brand")).filter((b) => !brands.has(String(b.brand_id)));
  if (foreign.length) {
    throw new Error(`target already holds other brands (${foreign.map((b) => b.brand_id).join(", ")}); use an empty database`);
  }
  for (const [table, reducer] of A_TABLES) await target.call(reducer, [read[table]]);
  if (read.product!.length) await target.call("upsert_products", [JSON.stringify(read.product)]);
  return Object.fromEntries(Object.entries(read).map(([t, rows]) => [t, rows.length]));
}

async function main() {
  const { values: args } = parseArgs({ options: { "from-maincloud": { type: "boolean", default: false } } });
  loadEnv();
  const uri = process.env.SPACETIMEDB_URI?.trim() ?? "";
  const dbName = process.env.SPACETIMEDB_DB_NAME?.trim() ?? "";
  if (!isLocalUri(uri)) {
    console.error(`refusing to seed ${uri || "(no SPACETIMEDB_URI)"} / ${dbName}: the seed only writes to a localhost server`);
    process.exit(1);
  }
  const db = await SpacetimeHttp.connect("sim-seed");
  if (args["from-maincloud"]) {
    // No token: the shared database's public tables answer SQL anonymously, and this client
    // never calls a reducer on it.
    const source = new SpacetimeHttp(MAINCLOUD.uri, MAINCLOUD.db, { name: "sim-seed-reader" });
    console.log(`copying ${MAINCLOUD.db} (MAINCLOUD, read-only) → ${uri} / ${dbName} (LOCAL) as ${db.name}`);
    const counts = await mirrorWorld(source, db);
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n} read`);
  } else {
    console.log(`seeding ${uri} / ${dbName} (LOCAL) as ${db.name}`);
    for (const [reducer, rows] of fixtureBatches()) {
      await db.call(reducer, [rows]);
      console.log(`  ${reducer}: ${rows.length} rows`);
    }
  }
  for (const table of [...A_TABLES.map(([t]) => t), "product"]) {
    console.log(`  ${table}: ${(await db.sql(`SELECT * FROM ${table}`)).length} rows in the database`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

import { loadEnv } from "./config.js";
import { loadWorld } from "./fixtures.js";
import { SpacetimeHttp, isLocalUri } from "./spacetime.js";

// The B5 test bench's stand-in for A4: loads the fixture world's brands, concepts, segments, arms
// and creatives into a LOCAL SpacetimeDB through A's own upsert reducers, in A's conventions
// (tables_a.ts: "" for empty, json columns as JSON strings). The conversion is the module test's
// (test/module/module.test.ts). Products are B's table; the worker writes them in --fixtures mode.
//
// Usage: SPACETIMEDB_URI=http://127.0.0.1:3100 SPACETIMEDB_DB_NAME=adlab-local npm run sim:local-seed
// It refuses any server that isn't localhost, so it can never write A's tables on Maincloud.

loadEnv();
const uri = process.env.SPACETIMEDB_URI?.trim() ?? "";
const dbName = process.env.SPACETIMEDB_DB_NAME?.trim() ?? "";
if (!isLocalUri(uri)) {
  console.error(`refusing to seed ${uri || "(no SPACETIMEDB_URI)"} / ${dbName}: the seed only writes to a localhost server`);
  process.exit(1);
}

const w = loadWorld();
const e = (v: unknown) => (v === null || v === undefined ? "" : v);
const j = (v: unknown) => JSON.stringify(v);
// Load order matters: A's reducers check references backwards (brand → concept → segment → arm → creative).
const batches: [string, object[]][] = [
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

const db = await SpacetimeHttp.connect("sim-seed");
console.log(`seeding ${uri} / ${dbName} (LOCAL) as ${db.name}`);
for (const [reducer, rows] of batches) {
  await db.call(reducer, [rows]);
  console.log(`  ${reducer}: ${rows.length} rows`);
}
for (const table of ["brand", "concept", "segment", "arm", "creative"]) {
  console.log(`  ${table}: ${(await db.sql(`SELECT * FROM ${table}`)).length} rows in the database`);
}

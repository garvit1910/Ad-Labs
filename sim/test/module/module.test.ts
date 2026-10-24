import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Db, SpacetimeError, type SqlRow, writer } from "../../src/spacetime.js";
import { Worker } from "../../src/worker.js";
import { fakeJev } from "../fake-jev.js";
import { loadWorld } from "../../src/fixtures.js";
// @ts-expect-error: built by `npm run test:module` from spacetime/src/index.ts (not type-checked here)
import spacetimedb, * as mod from "../../.cache/module.mjs";
// @ts-expect-error: the spacetime package's test harness, resolved through test/module/sys-hooks.mjs
import { TestAuth, createModuleTestHarness } from "../../../spacetime/node_modules/spacetimedb/dist/server/test-utils/index.mjs";

// The real SpacetimeDB module (spacetime/src/index.ts, bundled) in the official module test
// harness (spacetimedb/server/test-utils, docs: how-to/unit-testing), driven by the real sim
// worker. An adapter turns the worker's HTTP-style calls into reducer calls (positional args in
// each reducer's parameter order) and its SQL reads into table scans.
// Run with: npm run test:module

type Harness = {
  db: Record<string, { iter(): Iterable<Record<string, unknown>>; count(): bigint }>;
  withReducerTx<T>(auth: unknown, body: (ctx: unknown) => T): T;
};

const PARAMS: Record<string, string[]> = {
  upsert_products: ["rows_json"],
  upsert_creative_perceptions: ["rows_json"],
  upsert_run: ["row_json"],
  start_round: ["run_id", "round"],
  finish_round: ["run_id", "round", "status", "summary_json"],
  upsert_shoppers: ["run_id", "rows_json"],
  insert_decisions: ["rows_json"],
  replace_arm_stats: ["run_id", "round", "rows_json"],
  upsert_learnings: ["rows_json"],
  enqueue_task: ["task_id", "kind", "payload_json"],
  claim_task: ["task_id", "claimed_by"],
  complete_task: ["task_id", "result_json"],
  fail_task: ["task_id", "error"],
};

// Rows as the HTTP SQL endpoint hands them to the worker: options as null, u64 as numbers,
// timestamps as ISO strings.
function plain(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (v && typeof v === "object" && "microsSinceUnixEpoch" in v) {
    return new Date(Number((v as { microsSinceUnixEpoch: bigint }).microsSinceUnixEpoch) / 1000).toISOString();
  }
  return v;
}

function harnessDb(h: Harness, exports: Record<string, unknown>): Db {
  const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return {
    name: "harness-worker",
    async call(reducer, args) {
      const fn = exports[camel(reducer)] as ((ctx: unknown, a: object) => void) | undefined;
      const params = PARAMS[reducer];
      if (!fn || !params) throw new SpacetimeError(`no reducer ${reducer}`, 404);
      const obj = Object.fromEntries(params.map((p, i) => [p, args[i]]));
      try {
        h.withReducerTx(TestAuth.internal(), (ctx) => fn(ctx, obj));
      } catch (err) {
        throw new SpacetimeError(`${reducer}: ${(err as Error).message}`, 400);
      }
    },
    async sql(query) {
      const m = /^SELECT \* FROM (\w+)(?: WHERE (\w+) = '((?:[^']|'')*)')?$/.exec(query.trim());
      if (!m) throw new SpacetimeError(`unsupported query ${query}`);
      const [, table, col, value] = m;
      const rows = [...h.db[table!]!.iter()].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])) as SqlRow);
      return col ? rows.filter((r) => String(r[col]) === value!.replaceAll("''", "'")) : rows;
    },
  };
}

describe("the SpacetimeDB module in the official test harness", () => {
  const exports = mod as Record<string, unknown>;
  const fresh = () => {
    const h = createModuleTestHarness(spacetimedb, exports) as Harness;
    return { h, db: harnessDb(h, exports), count: (t: string) => Number(h.db[t]!.count()) };
  };

  test("A's and B's tables and reducers are all in the merged module, and nothing else is exported", () => {
    const { h } = fresh();
    for (const t of ["brand", "concept", "segment", "arm", "creative", "product", "creative_perception", "run", "round", "shopper", "decision", "arm_stat", "learning", "task"]) {
      assert.ok(h.db[t], t);
    }
    const reducersB = Object.keys(PARAMS).map((r) => r.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
    const reducersA = ["upsertBrands", "upsertConcepts", "upsertSegments", "upsertArms", "upsertCreatives", "resetATables"];
    assert.deepEqual(Object.keys(exports).sort(), ["default", "ping", ...reducersA, ...reducersB].sort());
  });

  test("the worker runs on A's tables, loaded through A's own reducers in A's conventions", async () => {
    const { h, db, count } = fresh();
    const w = loadWorld();
    // A's wire conventions (tables_a.ts): "" for empty, json columns as JSON strings, u32 integers.
    const e = (v: unknown) => (v === null || v === undefined ? "" : v);
    const j = (v: unknown) => JSON.stringify(v);
    const asA = {
      upsertBrands: w.brands,
      upsertConcepts: w.concepts,
      upsertSegments: w.segments.map((s) => ({ ...s, prior_weights: j(s.prior_weights), quotes: j(s.quotes) })),
      upsertArms: w.arms.map((a) => ({ ...a, angle: e(a.angle), hook: e(a.hook), evidence: j(a.evidence) })),
      upsertCreatives: w.creatives.map((c) => ({
        ...c,
        arm_id: e(c.arm_id),
        image_url: e(c.image_url),
        landing_product_id: e(c.landing_product_id),
        segment_id: e(c.segment_id),
        pack_fingerprint: e(c.pack_fingerprint),
        learning_ids: j(c.learning_ids),
      })),
    };
    for (const [reducer, rows] of Object.entries(asA)) {
      h.withReducerTx(TestAuth.internal(), (ctx) => (exports[reducer] as (c: unknown, a: object) => void)(ctx, { rows }));
    }
    // Products are B's table; the worker reads them from the database in this mode.
    await writer.products(db, w);
    assert.equal(count("creative"), 20);

    await writer.enqueue(db, "tsk_run_run_a_r0", "run_round", { run_id: "run_a", round: 0 });
    const worker = new Worker({ db, jev: fakeJev(), source: "db", log: () => {} });
    assert.equal(await worker.tick(), true);
    const task = [...h.db.task!.iter()].find((t) => t.task_id === "tsk_run_run_a_r0")!;
    assert.equal(task.status, "done", String(task.result));
    const round = [...h.db.round!.iter()].find((r) => r.run_id === "run_a")!;
    assert.equal(round.status, "done");
    const summary = JSON.parse(String(round.summary));
    assert.equal(summary.leaderboard.length, w.segments.length);
    assert.equal(summary.by_arm.length, 12);
  });

  test("the worker runs two rounds through the real reducers", async () => {
    const { h, db, count } = fresh();
    await writer.enqueue(db, "tsk_run_run_h_r0", "run_round", { run_id: "run_h", round: 0 });
    const worker = new Worker({ db, jev: fakeJev(), source: "fixtures", autoNext: true, log: () => {} });
    assert.equal(await worker.tick(), true);
    assert.equal(await worker.tick(), true);

    assert.equal(count("run"), 1);
    assert.equal(count("shopper"), 300);
    assert.equal(count("arm_stat"), 2 * 6 * 12);
    assert.equal(count("product"), 4);
    assert.equal(count("creative_perception"), 20);
    const rounds = [...h.db.round!.iter()];
    assert.deepEqual(rounds.map((r) => [r.round, r.status]).sort(), [[0, "done"], [1, "done"]]);
    for (const r of rounds) assert.ok(JSON.parse(String(r.summary)).leaderboard, "the summary lands in the round row");
    const decisions = rounds.reduce((n, r) => n + JSON.parse(String(r.summary)).jev.calls, 0);
    assert.equal(count("decision"), decisions);
    const tasks = Object.fromEntries([...h.db.task!.iter()].map((t) => [t.task_id, t.status]));
    assert.deepEqual(tasks, {
      tsk_run_run_h_r0: "done",
      tsk_gen_run_h_r0: "queued",
      tsk_run_run_h_r1: "done",
      tsk_gen_run_h_r1: "queued",
      tsk_run_run_h_r2: "queued",
    });
    assert.ok([...h.db.learning!.iter()].every((l) => l.source === "simulated"));
  });

  test("claim_task lets one claimer in; reducers reject bad input", async () => {
    const { db } = fresh();
    await writer.enqueue(db, "tsk_x", "run_round", { run_id: "run_h", round: 0 });
    await db.call("claim_task", ["tsk_x", "a"]);
    await assert.rejects(db.call("claim_task", ["tsk_x", "b"]), /is claimed/);
    await assert.rejects(db.call("complete_task", ["tsk_missing", "{}"]), /not found/);
    await assert.rejects(writer.enqueue(db, "tsk_x", "run_round", { run_id: "run_h", round: 0 }), /already exists/);
    await assert.rejects(db.call("enqueue_task", ["tsk_y", "nope", "{}"]), /kind/);
    await assert.rejects(db.call("enqueue_task", ["tsk_z", "generate_creatives", JSON.stringify({ run_id: "r", round: 0 })]), /arms/);
    const learning = { learning_id: "l", run_id: "r", segment_id: "s", kind: "winner", statement: "x", directive: "y", evidence: {}, valid_from_round: 0 };
    await assert.rejects(db.call("upsert_learnings", [JSON.stringify([{ ...learning, source: "observed" }])]), /simulated/);
    await assert.rejects(db.call("insert_decisions", [JSON.stringify([{ kind: "nope" }])]), /kind/);
    await assert.rejects(db.call("upsert_products", ["not json"]), /JSON/);
  });

  test("a perception is frozen per input hash", async () => {
    const { h, db } = fresh();
    const row = { creative_id: "cr_a", claims: { taste: 0.9 }, offer_pct: 0, input_hash: "h1" };
    await db.call("upsert_creative_perceptions", [JSON.stringify([row])]);
    await db.call("upsert_creative_perceptions", [JSON.stringify([{ ...row, claims: { taste: 0.1 } }])]);
    assert.equal([...h.db.creative_perception!.iter()][0]!.claims, '{"taste":0.9}');
    await db.call("upsert_creative_perceptions", [JSON.stringify([{ ...row, claims: { taste: 0.1 }, input_hash: "h2" }])]);
    assert.equal([...h.db.creative_perception!.iter()][0]!.claims, '{"taste":0.1}');
  });
});

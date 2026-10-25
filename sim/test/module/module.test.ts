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
    for (const t of ["brand", "concept", "segment", "arm", "creative", "product", "creative_perception", "run", "round", "shopper", "decision", "arm_stat", "learning", "task", "agent", "agent_message", "ingest_job", "brand_kit"]) {
      assert.ok(h.db[t], t);
    }
    const reducersB = Object.keys(PARAMS).map((r) => r.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
    const reducersA = ["upsertBrands", "upsertConcepts", "upsertSegments", "upsertArms", "upsertCreatives", "resetATables", "upsertAgent", "logAgentMessage", "upsertIngestJob", "reportIngestJob", "upsertBrandKit"];
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

// The wire contract, read from the module definition SpacetimeDB publishes
// (Schema.buildRawModuleDefV10), checked against docs/PLAN.md "The contract", the contract schemas
// the loader reads A's rows with, and what the worker actually sends.
describe("wire contract: published module vs the plan, the loader and the worker", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const contract = await import("../../src/contract.js");
  type Section = { tag: string; value: unknown };
  type Elements = { elements: { name: string; algebraicType: { tag: string } }[] };
  const def = (spacetimedb as { buildRawModuleDefV10(e: object): { sections: Section[] } }).buildRawModuleDefV10(mod);
  const section = <T>(tag: string) => def.sections.find((s) => s.tag === tag)!.value as T;
  const types = section<{ types: { tag: string; value: Elements }[] }>("Typespace").types;
  const columns = Object.fromEntries(
    section<{ sourceName: string; productTypeRef: number }[]>("Tables").map((t) => [t.sourceName, types[t.productTypeRef]!.value.elements.map((e) => e.name)]),
  );
  const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const reducers = Object.fromEntries(
    section<{ sourceName: string; params: Elements }[]>("Reducers").map((r) => [snake(r.sourceName), r.params.elements.map((e) => e.name)]),
  );

  // docs/PLAN.md "The contract": | table | field, field (json …), … | rules |
  const plan = readFileSync(new URL("../../../docs/PLAN.md", import.meta.url), "utf8");
  const block = plan.slice(plan.indexOf("## The contract"), plan.indexOf("Payloads:", plan.indexOf("## The contract")));
  const planFields: Record<string, string[]> = {};
  for (const line of block.split("\n")) {
    const m = /^\| ([a-z_\\]+) \| (.+?) \| /.exec(line);
    if (!m) continue;
    planFields[m[1]!.replaceAll("\\_", "_")] = m[2]!.replaceAll("\\_", "_").replace(/\s*\([^)]*\)/g, "").split(",").map((f) => f.trim());
  }

  test("names on the wire are snake_case (the module's case policy)", () => {
    assert.deepEqual(section("CaseConversionPolicy"), { tag: "SnakeCase" });
  });

  test("every table has exactly the plan's contract fields, in the plan's order", () => {
    assert.deepEqual(Object.keys(columns).sort(), Object.keys(planFields).sort());
    for (const [table, fields] of Object.entries(planFields)) assert.deepEqual(columns[table], fields, table);
  });

  test("A's tables match the contract schemas the loader parses them with", () => {
    const schemas = {
      brand: contract.brandSchema,
      concept: contract.conceptSchema,
      segment: contract.segmentSchema,
      arm: contract.armSchema,
      creative: contract.creativeSchema,
      product: contract.productSchema,
    };
    for (const [table, schema] of Object.entries(schemas)) {
      assert.deepEqual(Object.keys((schema as unknown as { shape: object }).shape), columns[table], table);
    }
  });

  test("every reducer the sim calls exists, with the parameters it sends, in order", () => {
    const called = new Set<string>();
    for (const f of readdirSync(new URL("../../src/", import.meta.url))) {
      for (const m of readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8").matchAll(/call\("([a-z_]+)"/g)) called.add(m[1]!);
    }
    assert.ok(called.size >= 13, [...called].join());
    for (const r of called) {
      assert.ok(reducers[r], `the sim calls ${r}, which the module doesn't have`);
      assert.deepEqual(reducers[r], PARAMS[r], `${r} parameters`);
    }
  });

  test("every row the worker writes has exactly its table's columns", async () => {
    const exports = mod as Record<string, unknown>;
    const h = createModuleTestHarness(spacetimedb, exports) as Harness;
    const inner = harnessDb(h, exports);
    const sent: { reducer: string; args: unknown[] }[] = [];
    const db: Db = { ...inner, name: inner.name, call: (r, a) => (sent.push({ reducer: r, args: a }), inner.call(r, a)), sql: (q) => inner.sql(q) };
    await writer.enqueue(db, "tsk_run_run_w_r0", "run_round", { run_id: "run_w", round: 0 });
    await new Worker({ db, jev: fakeJev(), source: "fixtures", log: () => {} }).tick();

    for (const { reducer, args } of sent) assert.equal(args.length, PARAMS[reducer]!.length, `${reducer} argument count`);
    const rows = (reducer: string, i: number) => sent.filter((c) => c.reducer === reducer).flatMap((c) => JSON.parse(String(c.args[i])) as object[]);
    const keysOf = (rs: object[]) => [...new Set(rs.flatMap((r) => Object.keys(r)))].sort();
    const without = (cols: string[], ...drop: string[]) => cols.filter((c) => !drop.includes(c)).sort();
    // run_id and round come in as reducer arguments; created_at, started_at and the like are set by
    // the server from ctx.timestamp.
    assert.deepEqual(keysOf(rows("upsert_products", 0)), without(columns.product!));
    assert.deepEqual(keysOf(rows("upsert_creative_perceptions", 0)), without(columns.creative_perception!));
    const runRows = sent.filter((c) => c.reducer === "upsert_run").map((c) => JSON.parse(String(c.args[0])) as object);
    assert.ok(runRows.length >= 1);
    assert.deepEqual(keysOf(runRows), without(columns.run!, "created_at"));
    assert.deepEqual(keysOf(rows("upsert_shoppers", 1)), without(columns.shopper!, "run_id"));
    assert.deepEqual(keysOf(rows("insert_decisions", 0)), without(columns.decision!));
    assert.deepEqual(keysOf(rows("replace_arm_stats", 2)), without(columns.arm_stat!));
    assert.deepEqual(keysOf(rows("upsert_learnings", 0)), without(columns.learning!));
    // Task payloads: the plan's shapes exactly.
    const payload = (kind: string) => sent.filter((c) => c.reducer === "enqueue_task" && c.args[1] === kind).map((c) => JSON.parse(String(c.args[2])));
    assert.deepEqual(keysOf(payload("run_round")), ["round", "run_id"]);
    assert.deepEqual(keysOf(payload("generate_creatives")), ["arms", "learning_ids", "n_per_arm", "round", "run_id"]);
    for (const p of payload("generate_creatives")) for (const a of p.arms) assert.deepEqual(Object.keys(a).sort(), ["arm_id", "segment_ids"]);
  });
});

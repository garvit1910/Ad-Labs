import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadWorld } from "../src/fixtures.js";
import { decodeRows, decodeValue, loadWorldFromDb, sqlString, writer } from "../src/spacetime.js";
import { Worker } from "../src/worker.js";
import { FakeDb } from "./fake-db.js";
import { fakeJev } from "./fake-jev.js";

const world = loadWorld();
const quiet = () => {};
const POP = 60;

// A run row's settings come from the defaults; tests shrink the population through the run row.
async function startRun(db: FakeDb, run_id: string, population = POP) {
  await writer.run(db, {
    run_id,
    seed: 13,
    population,
    rounds_planned: 2,
    ticks_per_round: 3,
    status: "queued",
    calibration: {},
    jev_model: "jev-1.13.0",
    config_hash: "pending",
  });
  await writer.enqueue(db, `tsk_run_${run_id}_r0`, "run_round", { run_id, round: 0 });
}

describe("SATS-JSON decoding (SQL rows)", () => {
  const schema = {
    elements: [
      { name: { some: "run_id" }, algebraic_type: { String: [] } },
      { name: { some: "round" }, algebraic_type: { U32: [] } },
      {
        name: { some: "started_at" },
        algebraic_type: {
          Sum: {
            variants: [
              { name: { some: "some" }, algebraic_type: { Product: { elements: [{ name: { some: "__timestamp_micros_since_unix_epoch__" }, algebraic_type: { I64: [] } }] } } },
              { name: { some: "none" }, algebraic_type: { Product: { elements: [] } } },
            ],
          },
        },
      },
    ],
  };
  test("products as arrays or objects; options by index or name; timestamps to ISO", () => {
    const micros = Date.parse("2026-10-24T14:30:00Z") * 1000;
    const rows = decodeRows({ schema, rows: [["run_a", 0, { "0": [micros] }], { run_id: "run_b", round: 1, started_at: { none: [] } }] });
    assert.deepEqual(rows, [
      { run_id: "run_a", round: 0, started_at: "2026-10-24T14:30:00.000Z" },
      { run_id: "run_b", round: 1, started_at: null },
    ]);
    assert.equal(decodeValue(schema.elements[2]!.algebraic_type, { some: [micros] }), "2026-10-24T14:30:00.000Z");
    assert.equal(decodeValue(schema.elements[2]!.algebraic_type, { "1": [] }), null);
    // What the live server sends (2.13.0): [tag, value].
    assert.equal(decodeValue(schema.elements[2]!.algebraic_type, [0, [micros]]), "2026-10-24T14:30:00.000Z");
    assert.equal(decodeValue(schema.elements[2]!.algebraic_type, [1, []]), null);
  });
  test("SQL string literals are escaped", () => {
    assert.equal(sqlString("it's"), "'it''s'");
  });
});

describe("loading A's rows", () => {
  test("contract-shaped rows (json columns as JSON text, empties as null) load into the same world as the fixtures", async () => {
    const db = new FakeDb();
    const asDb = <T extends object>(rows: T[], jsonCols: string[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, jsonCols.includes(k) ? JSON.stringify(v) : v])));
    db.tables.set("brand", asDb(world.brands, []));
    db.tables.set("concept", asDb(world.concepts, []));
    db.tables.set("segment", asDb(world.segments, ["prior_weights", "quotes"]));
    db.tables.set("product", asDb(world.products, ["page_highlights"]));
    db.tables.set("arm", asDb(world.arms, ["evidence"]));
    db.tables.set("creative", asDb([...world.creatives].reverse(), ["learning_ids"]));
    const loaded = await loadWorldFromDb(db, 0);
    const sorted = <T>(rows: T[], k: keyof T) => [...rows].sort((a, b) => String(a[k]).localeCompare(String(b[k])));
    assert.deepEqual(loaded.creatives, sorted(world.creatives, "creative_id"), "order by id, whatever SQL returns");
    assert.deepEqual(loaded.segments, sorted(world.segments, "segment_id"));
    // Creatives written for a later round stay out of an earlier round's world.
    db.rows("creative").push({ ...db.rows("creative")[0]!, creative_id: "cr_gen_r2", round_created: 2 });
    assert.ok(!(await loadWorldFromDb(db, 1)).creatives.some((c) => c.creative_id === "cr_gen_r2"));
    assert.ok((await loadWorldFromDb(db, 2)).creatives.some((c) => c.creative_id === "cr_gen_r2"));
  });
  test("a row that breaks the contract fails loudly with the table and field", async () => {
    const db = new FakeDb();
    for (const t of ["brand", "concept", "segment", "product", "arm", "creative"]) db.tables.set(t, []);
    db.tables.set("brand", [{ brand_id: "br_x", name: "X" }]);
    await assert.rejects(loadWorldFromDb(db, 0), /brand:[\s\S]*is_client/);
  });
});

describe("worker: the task board round trip (fake SpacetimeDB, stub Jev)", () => {
  test("claims run_round, writes every B table, lands the summary in the round row, queues generate_creatives", async () => {
    const db = new FakeDb();
    await startRun(db, "run_t");
    const worker = new Worker({ db, jev: fakeJev(), source: "fixtures", log: quiet });
    assert.equal(await worker.tick(), true);

    const task = db.rows("task").find((t) => t.task_id === "tsk_run_run_t_r0")!;
    assert.equal(task.status, "done");
    assert.equal(task.claimed_by, "test-worker");
    const round = db.rows("round").find((r) => r.run_id === "run_t" && r.round === 0)!;
    assert.equal(round.status, "done");
    assert.ok(round.started_at && round.finished_at);
    const summary = JSON.parse(String(round.summary));
    assert.equal(summary.round, 0);
    assert.ok(summary.leaderboard.length === world.segments.length && summary.config_hash && summary.calibration.offsets);

    const run = db.rows("run").find((r) => r.run_id === "run_t")!;
    assert.equal(run.population, POP, "settings come from the run row");
    assert.equal(run.status, "running");
    assert.equal(run.config_hash, summary.config_hash);
    assert.deepEqual(JSON.parse(String(run.calibration)).offsets, summary.calibration.offsets);

    assert.equal(db.rows("shopper").length, POP);
    // state_text is the page state, the last text Jev read; a shopper who never scrolled has none yet.
    const texts = db.rows("shopper").map((s) => String(s.state_text));
    assert.ok(texts.filter(Boolean).every((s) => s.includes("THE PAGE") && !s.includes("RIGHT NOW")));
    assert.ok(texts.filter(Boolean).length >= POP * 0.9);
    assert.equal(db.rows("decision").length, summary.jev.calls);
    assert.equal(db.rows("arm_stat").length, world.segments.length * 12);
    assert.equal(db.rows("product").length, world.products.length);
    assert.equal(db.rows("creative_perception").length, world.creatives.length);
    assert.ok(db.rows("learning").every((l) => l.source === "simulated"));

    const gen = db.rows("task").find((t) => t.kind === "generate_creatives")!;
    assert.equal(gen.task_id, "tsk_gen_run_t_r0");
    assert.equal(gen.status, "queued");
    const payload = JSON.parse(String(gen.payload));
    assert.deepEqual(Object.keys(payload).sort(), ["arms", "learning_ids", "n_per_arm", "round", "run_id"]);
    assert.ok(payload.arms.length >= 1 && payload.arms.length <= 3);

    // One call per table per sim day: 3 days × (decisions, shoppers, arm stats).
    const perDay = ["insert_decisions", "upsert_shoppers", "replace_arm_stats"];
    for (const r of perDay) assert.equal(db.calls.filter((c) => c.reducer === r).length, 3, r);
    assert.equal(await worker.tick(), false, "nothing left to claim");
  });

  test("two workers never take the same task", async () => {
    const db = new FakeDb();
    await startRun(db, "run_race");
    const [a, b] = [new Worker({ db, jev: fakeJev(), source: "fixtures", log: quiet }), new Worker({ db, jev: fakeJev(), source: "fixtures", log: quiet })];
    const [ta, tb] = await Promise.all([a.claimNext(), b.claimNext()]);
    assert.equal([ta, tb].filter(Boolean).length, 1);
  });

  test("a restarted worker replays earlier rounds from the cache and writes the same round 1", async () => {
    const jev = fakeJev();
    const one = new FakeDb();
    await startRun(one, "run_r");
    const steady = new Worker({ db: one, jev, source: "fixtures", autoNext: true, log: quiet });
    await steady.tick();
    await steady.tick();

    const two = new FakeDb();
    await startRun(two, "run_r");
    await new Worker({ db: two, jev, source: "fixtures", autoNext: true, log: quiet }).tick();
    // A new worker (no memory of the run) picks up round 1.
    const fresh = new Worker({ db: two, jev, source: "fixtures", log: quiet });
    await fresh.tick();

    const summary = (db: FakeDb) => JSON.parse(String(db.rows("round").find((r) => r.round === 1)!.summary));
    assert.deepEqual(summary(two), summary(one));
    const decisions = (db: FakeDb) => db.rows("decision").filter((d) => d.round === 1).map(({ latency_ms: _l, cache_hit: _c, ...d }) => d);
    assert.deepEqual(decisions(two), decisions(one));
  });

  test("a failed round marks the task failed with the error", async () => {
    const db = new FakeDb();
    await writer.enqueue(db, "tsk_run_ghost_r1", "run_round", { run_id: "ghost", round: 1 });
    await new Worker({ db, jev: fakeJev(), source: "fixtures", log: quiet }).tick();
    const t = db.rows("task")[0]!;
    assert.equal(t.status, "failed");
    assert.match(String(t.result), /no run row/);
  });
});

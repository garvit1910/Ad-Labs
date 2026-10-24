import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ZERO_OFFSETS, calibrate } from "../src/calibrate.js";
import { type Asker, Engine } from "../src/engine.js";
import { assembleFeed } from "../src/feed.js";
import { type World, loadWorld } from "../src/fixtures.js";
import { JevClient, type JevResult, type Questions } from "../src/jev.js";
import { EVIDENCE, applyEvidence, blend } from "../src/memory.js";
import { perceiveAll } from "../src/perceive.js";
import { type Opinion, makeShopper } from "../src/population.js";
import { priceComparison, renderAd, wordCount } from "../src/render.js";
import { roundSummary } from "../src/summary.js";

const world = loadWorld();
const perceptions = await perceiveAll(world);
const SEED = 13;

const hashUnit = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest().readUInt32BE(0) / 2 ** 32;

// A stand-in for Jev: answers are a pure function of (state, question), or fixed overrides.
function fakeJev(fixed: Partial<Record<string, number>> = {}, onAsk?: (state: string) => void): Asker {
  return {
    async ask<Q extends Questions>(state: string, questions: Q): Promise<JevResult<Q>> {
      onAsk?.(state);
      const answers: Record<string, unknown> = {};
      for (const [name, q] of Object.entries(questions)) {
        const tapKey = name.startsWith("tap_") ? "tap" : name;
        if (q.type === "noul") answers[name] = { type: "noul", noul: fixed[tapKey] ?? Math.round(hashUnit(state, name) * 100) / 100 };
        else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0]));
          answers[name] = { type: "choice", choice: keys[0], confidence: 1, probabilities };
        }
      }
      const request = { model: "jev-1.13.0", state, questions };
      return {
        model: "jev-1.13.0",
        answers: answers as JevResult<Q>["answers"],
        usage: { input_tokens: wordCount(state), output_tokens: 1 },
        latencyMs: 0,
        cacheHit: false,
        cacheKey: JevClient.cacheKey(request),
        request,
      };
    },
  };
}

async function runRounds(jev: Asker, opts: { population: number; rounds: number; world?: World; seed?: number }) {
  const w = opts.world ?? world;
  const seed = opts.seed ?? SEED;
  const engine = new Engine(w, jev, perceptions, { run_id: "run_test", seed, population: opts.population });
  const summaries = [];
  const decisions = [];
  for (let r = 0; r < opts.rounds; r++) {
    const days = await engine.runRound(r);
    summaries.push(roundSummary(w, { run_id: "run_test", seed, population: opts.population, offsets: ZERO_OFFSETS }, days));
    decisions.push(...days.flatMap((d) => d.decisions));
  }
  return { engine, summaries, decisions };
}

const withPrice = (price: number): World => ({
  ...world,
  products: world.products.map((p) => ({ ...p, price_usd: price, subscription_price_usd: price })),
});

describe("B2 test 1: same seed + warm cache gives identical output", () => {
  const dir = mkdtempSync(join(tmpdir(), "b2-cache-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  test("a cold run, then a warm run with the network cut, print the same summary", async () => {
    // Like real Jev, the stub is not deterministic: fresh answers are random every time.
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const { questions } = JSON.parse(String(init.body)) as { questions: Questions };
      const answers: Record<string, unknown> = {};
      for (const [name, q] of Object.entries(questions)) {
        if (q.type === "noul") answers[name] = { type: "noul", noul: Math.round(Math.random() * 100) / 100 };
        else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const pick = keys[Math.floor(Math.random() * keys.length)]!;
          answers[name] = { type: "choice", choice: pick, confidence: 1, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 1 : 0])) };
        }
      }
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 700, output_tokens: 5 } }));
    }) as typeof fetch;
    const path = join(dir, "cache.sqlite");
    const cold = new JevClient({ apiKey: "k", cachePath: path });
    const first = await runRounds(cold, { population: 60, rounds: 2 });
    cold.close();

    globalThis.fetch = (async () => {
      throw new Error("network used on a warm cache");
    }) as typeof fetch;
    const warm = new JevClient({ apiKey: "k", cachePath: path });
    const second = await runRounds(warm, { population: 60, rounds: 2 });
    warm.close();

    assert.ok(second.decisions.every((d) => d.cache_hit));
    assert.equal(JSON.stringify(second.summaries), JSON.stringify(first.summaries));
    const strip = (ds: typeof first.decisions) => ds.map(({ latency_ms: _l, cache_hit: _c, ...rest }) => rest);
    assert.deepEqual(strip(second.decisions), strip(first.decisions));
  });

  test("a different seed gives a different run", async () => {
    const a = await runRounds(fakeJev(), { population: 60, rounds: 1 });
    const b = await runRounds(fakeJev(), { population: 60, rounds: 1, seed: 14 });
    assert.notEqual(JSON.stringify(a.summaries), JSON.stringify(b.summaries));
  });
});

describe("B2 test 2: the budget guard zeroes P(buy)", () => {
  const sure = { tap: 0.99, stays: 0.99, buys: 0.99 };
  test("price over every budget: P_cal(buy) = 0 on every impression, and nobody buys", async () => {
    const { decisions, summaries } = await runRounds(fakeJev(sure), { population: 80, rounds: 1, world: withPrice(10_000) });
    const pages = decisions.filter((d) => d.kind === "page");
    assert.ok(pages.length > 100);
    for (const d of pages) {
      assert.equal(d.p_cal.buy, 0);
      assert.equal(d.p_cal.guard, 0);
      assert.equal(d.p_raw.buy, 0.99, "the raw answer is kept");
    }
    assert.equal(summaries[0]!.buys, 0);
    assert.ok(summaries[0]!.stays > 0, "shoppers still tap and look");
    assert.equal(summaries[0]!.budget_guarded, summaries[0]!.impressions);
  });
  test("price under every budget: the guard stays open and shoppers buy", async () => {
    const { summaries } = await runRounds(fakeJev(sure), { population: 80, rounds: 1, world: withPrice(1) });
    assert.equal(summaries[0]!.budget_guarded, 0);
    assert.ok(summaries[0]!.buys > 0);
  });
  test("at a real price, the guard compares with each shopper's budget left that day", async () => {
    const engine = new Engine(withPrice(39), fakeJev(sure), perceptions, { run_id: "run_test", seed: SEED, population: 150 });
    const startBudget = new Map(engine.shoppers.map((s) => [s.shopper_id, s.budget_left_usd]));
    let guarded = 0;
    let open = 0;
    let guardedAfterSpending = 0;
    for (const tick of engine.ticksOf(0)) {
      const budgetToday = new Map(engine.shoppers.map((s) => [s.shopper_id, s.budget_left_usd]));
      const day = await engine.runDay(0, tick);
      for (const i of day.impressions) {
        const over = 39 > budgetToday.get(i.shopper_id)!;
        assert.equal(i.guard, over ? 0 : 1, i.shopper_id);
        assert.equal(i.p_cal.buy, over ? 0 : 0.99, i.shopper_id);
        if (over) guarded++;
        else open++;
        // Could afford it at the start of the run, but not after an earlier purchase.
        if (over && startBudget.get(i.shopper_id)! >= 39) guardedAfterSpending++;
      }
    }
    assert.ok(guarded > 20 && open > 20, `${guarded} guarded, ${open} open`);
    assert.ok(guardedAfterSpending > 0, "the guard reads the budget left, not the starting budget");
  });
  test("calibration never lifts a guarded zero", () => {
    // The clamp would turn 0 into 0.005; the engine sets 0 after calibrating instead.
    assert.equal(calibrate(0, 0), 0.005);
  });
});

describe("B2 test 3: tap → stay → buy matches hand-computed values", () => {
  test("the evidence table on a 0.45 prior (E 2) and an empty opinion", () => {
    const s = makeShopper(0, world, SEED);
    s.preferences.high_protein = { w: 0.45, E: 2 };
    applyEvidence(s, "tap", "br_magic_spoon", ["high_protein"]);
    // (2·0.45 + 0.10·1) / 2.10 = 1.00 / 2.10
    assert.ok(Math.abs(s.preferences.high_protein.w - 0.476190) < 1e-6);
    assert.ok(Math.abs(s.preferences.high_protein.E - 2.1) < 1e-12);
    assert.equal(s.opinions.br_magic_spoon, undefined, "a tap never forms an opinion");
    applyEvidence(s, "stay", "br_magic_spoon", ["high_protein"]);
    // (2.10·0.476190 + 0.25) / 2.35 = 1.25 / 2.35
    assert.ok(Math.abs(s.preferences.high_protein.w - 0.531915) < 1e-6);
    assert.deepEqual(s.opinions.br_magic_spoon, { value: 0.6, E: 0.75, page_visits: 1, purchases: 0 });
    applyEvidence(s, "buy", "br_magic_spoon", ["high_protein"]);
    // (2.35·0.531915 + 1.00) / 3.35 = 2.25 / 3.35; opinion (0.75·0.6 + 1.5·0.65) / 2.25
    assert.ok(Math.abs(s.preferences.high_protein.w - 0.671642) < 1e-6);
    assert.ok(Math.abs(s.preferences.high_protein.E - 3.35) < 1e-12);
    const o = s.opinions.br_magic_spoon as Opinion;
    assert.ok(Math.abs(o.value - 0.633333) < 1e-6);
    assert.deepEqual([o.E, o.page_visits, o.purchases], [2.25, 1, 1]);
  });
  test("seeing and bouncing teach nothing; E caps at 8; changes under 0.01 are ignored", () => {
    const s = makeShopper(0, world, SEED);
    const before = structuredClone(s.preferences);
    applyEvidence(s, "seen", "br_magic_spoon", ["high_protein", "taste"]);
    applyEvidence(s, "bounce", "br_magic_spoon", ["high_protein", "taste"]);
    assert.deepEqual(s.preferences, before);
    assert.deepEqual(s.opinions, {});
    assert.equal(blend(0.5, 7.5, 1, 1).E, 8);
    s.preferences.taste = { w: 0.92, E: 2 };
    applyEvidence(s, "tap", "br_magic_spoon", ["taste"]); // +0.0038
    assert.deepEqual(s.preferences.taste, { w: 0.92, E: 2 });
    assert.equal(EVIDENCE.stay.pref, 0.25, "one STAY row per page visit");
  });
  test("in the engine, tap+bounce and tap+stay land on hand-computed values", async () => {
    // Every preference starts at 0.45 (E 2), so the expected values are the literal ones above.
    const cases = [
      { stays: 0.005, w: 0.47619, opinion: undefined, kinds: ["tap"], pick: (i: { stayed: boolean }) => !i.stayed },
      {
        stays: 0.995,
        w: 0.531915,
        opinion: { value: 0.6, E: 0.75, page_visits: 1, purchases: 0 },
        kinds: ["tap", "stay"],
        pick: (i: { stayed: boolean; bought: boolean }) => i.stayed && !i.bought,
      },
    ];
    for (const c of cases) {
      const engine = new Engine(withPrice(1), fakeJev({ tap: 0.995, stays: c.stays, buys: 0.005 }), perceptions, {
        run_id: "run_test",
        seed: SEED,
        population: 40,
      });
      for (const s of engine.shoppers) for (const k of Object.keys(s.preferences)) s.preferences[k] = { w: 0.45, E: 2 };
      const day = await engine.runDay(0, 0);
      const hits = day.impressions.filter((i) => i.tapped && c.pick(i));
      assert.ok(hits.length > 20, `${hits.length} ${c.kinds.join("+")} impressions`);
      for (const imp of hits) {
        const s = engine.shoppers.find((x) => x.shopper_id === imp.shopper_id)!;
        const claimed = new Set(engine.claimed(world.creatives.find((x) => x.creative_id === imp.creative_id)!));
        assert.ok(claimed.size > 0);
        for (const [k, p] of Object.entries(s.preferences)) {
          if (claimed.has(k)) assert.ok(Math.abs(p.w - c.w) < 1e-6, `${k} ${p.w}`);
          else assert.deepEqual(p, { w: 0.45, E: 2 }, `${k} is not claimed and must not move`);
        }
        assert.deepEqual(s.opinions.br_magic_spoon, c.opinion);
        assert.deepEqual(s.engagements.map((e) => e.kind), c.kinds);
        assert.equal(s.expected_price_usd.prd_magic_spoon_variety_4pk, c.opinion ? 1 : undefined, "price is seen only on a stay");
      }
    }
  });
  test("in the engine, a forced chain applies exactly tap, stay, buy to the ad's claimed concepts", async () => {
    const sure = { tap: 0.995, stays: 0.995, buys: 0.995 };
    const engine = new Engine(withPrice(1), fakeJev(sure), perceptions, { run_id: "run_test", seed: SEED, population: 40 });
    const before = engine.shoppers.map((s) => structuredClone(s));
    const day = await engine.runDay(0, 0);
    const chains = day.impressions.filter((i) => i.tapped && i.stayed && i.bought);
    assert.ok(chains.length > 20);
    for (const imp of chains) {
      const after = engine.shoppers.find((s) => s.shopper_id === imp.shopper_id)!;
      const expected = structuredClone(before.find((s) => s.shopper_id === imp.shopper_id)!);
      const creative = world.creatives.find((c) => c.creative_id === imp.creative_id)!;
      for (const kind of ["tap", "stay", "buy"] as const) applyEvidence(expected, kind, creative.brand_id, engine.claimed(creative));
      assert.deepEqual(after.preferences, expected.preferences, imp.shopper_id);
      assert.deepEqual(after.opinions, expected.opinions, imp.shopper_id);
      assert.equal(after.budget_left_usd, expected.budget_left_usd - 1);
      assert.equal(after.in_market, false, "a purchase ends the shopping flag");
      assert.equal(after.expected_price_usd.prd_magic_spoon_variety_4pk, 1);
      assert.deepEqual(after.engagements.map((e) => e.kind), ["tap", "stay", "buy"]);
      assert.equal(after.exposures.length, 3, "every ad seen is logged");
    }
  });
});

describe("B2 test 4: every state is under 450 words, with no segment names", () => {
  test("all feed and page states over 3 rounds of 300 shoppers, as memory fills up", async () => {
    const states: string[] = [];
    // Answers high enough that memory fills with taps, visits, purchases and prices.
    await runRounds(fakeJev({ tap: 0.6, stays: 0.7, buys: 0.5 }, (s) => states.push(s)), {
      population: 300,
      rounds: 3,
      world: withPrice(40),
    });
    assert.ok(states.length > 4000);
    let max = 0;
    const names = world.segments.flatMap((s) => [s.name, s.segment_id, s.segment_id.replace(/^seg_/, "")]);
    for (const state of states) {
      max = Math.max(max, wordCount(state));
      for (const n of names) assert.ok(!state.toLowerCase().includes(n.toLowerCase()), `"${n}" in a state`);
    }
    assert.ok(max < 450, `longest state ${max} words`);
    // Rule 4: the budget never appears. The only dollar amounts are the page price and the
    // expected-price memory line.
    for (const state of states) {
      assert.ok(!/budget/i.test(state));
      for (const line of state.split("\n").filter((l) => l.includes("$"))) {
        assert.match(line, / one-time|^Thinks the |^Magic Spoon: |^- /, line);
      }
    }
    // Memory really did fill: the later states carry engagement and price lines.
    assert.ok(states.some((s) => s.includes("looked at the page and bought")));
    assert.ok(states.some((s) => s.includes("Price compared with what they expected: about what they expected")));
  });
  test("the price gap is in words (rule 3)", () => {
    assert.equal(priceComparison(undefined, 40), "first time seeing a price");
    assert.equal(priceComparison(40, 42), "about what they expected");
    assert.equal(priceComparison(40, 48), "about 20% more than expected");
    assert.equal(priceComparison(40, 30), "cheaper than expected");
  });
});

describe("B2 test 5: option order changes with the seed", () => {
  test("same seed, same order; another seed reorders many feeds", () => {
    let changed = 0;
    const ours = world.creatives.find((c) => c.creative_id === "cr_gen_01")!;
    for (let i = 0; i < 200; i++) {
      const s = makeShopper(i, world, SEED);
      const a = assembleFeed(s, ours, world, SEED, 0).map((o) => o.creative.creative_id);
      assert.deepEqual(assembleFeed(s, ours, world, SEED, 0).map((o) => o.creative.creative_id), a);
      const b = assembleFeed(s, ours, world, SEED + 1, 0).map((o) => o.creative.creative_id);
      if (a.join() !== b.join()) changed++;
      // Our ad's slot also moves, not just which neighbours appear.
    }
    assert.ok(changed > 150, `${changed}/200 feeds changed`);
    const slot = (seed: number) =>
      Array.from({ length: 200 }, (_, i) =>
        assembleFeed(makeShopper(i, world, SEED), ours, world, seed, 0).findIndex((o) => o.creative === ours),
      );
    const a = slot(SEED);
    const b = slot(SEED + 1);
    assert.ok(a.filter((x, i) => x !== b[i]).length > 100);
    for (const k of [0, 1, 2]) assert.ok(a.filter((x) => x === k).length > 40, `slot ${k} used`);
  });
  test("the seeded order is the order Jev reads and the order the decision row records", async () => {
    const engine = new Engine(world, fakeJev(), perceptions, { run_id: "run_test", seed: SEED, population: 60 });
    const day = await engine.runDay(0, 0);
    const byId = new Map(world.creatives.map((c) => [c.creative_id, c]));
    for (const d of day.decisions.filter((x) => x.kind === "feed")) {
      const listed = engine.lastState.get(d.shopper_id)!.feed.split("\n").filter((l) => l.startsWith("- "));
      assert.deepEqual(listed, d.options.order!.map((id) => `- ${renderAd(byId.get(id)!, world)}`));
    }
  });
  test("the page call keeps the feed call's SHOPPER and MEMORY blocks exactly", async () => {
    const engine = new Engine(withPrice(40), fakeJev({ tap: 0.6, stays: 0.7, buys: 0.5 }), perceptions, {
      run_id: "run_test",
      seed: SEED,
      population: 120,
    });
    for (const tick of engine.ticksOf(0)) {
      await engine.runDay(0, tick);
      for (const { feed, page } of engine.lastState.values()) {
        assert.equal(page.split("\n\nTHEY TAPPED\n")[0], feed.split("\n\nRIGHT NOW\n")[0]);
      }
    }
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { FUNNEL_BANDS, TARGETS } from "../src/calibrate.js";
import { config } from "../src/config.js";
import { EPSILON, EVIDENCE, E_MAX, PRICE_KEEP, applyEvidence } from "../src/memory.js";
import { loadWorld } from "../src/fixtures.js";
import { makeShopper } from "../src/population.js";

// B2 and B3 carry ShopSim's rules over (docs/PLAN.md "What carries over from ShopSim"). These
// tests read ShopSim's own export, docs/sim-export/, so a copied constant can't drift, and each
// deliberate departure is written down as one.

// docs/ has no package.json, so tsc would type contracts.ts as CommonJS; load it at run time and
// type only what is compared here.
type Row = { pref_weight: number; belief_weight: number | null; belief_target: number | null };
type ShopSim = {
  EVIDENCE: {
    E_CAP: number;
    PRIOR_E0: number;
    EPSILON: number;
    MAX_SUBJECTIVE_WRITES_PER_TICK: number;
    REF_PRICE_ALPHA: number;
    COLD_START_PREFERS: { w: number; E: number };
    table: Record<"SAW" | "CLICKED" | "VISITED" | "BROWSED" | "CARTED" | "BOUGHT", Row>;
  };
  FUNNEL_BANDS: Record<"p_click" | "bounce_rate" | "visit_to_purchase", readonly [number, number]>;
};
const shopsim = (await import(new URL("../../docs/sim-export/contracts.ts", import.meta.url).href)) as ShopSim;
const notes = readFileSync(new URL("../../docs/sim-export/SIM_NOTES.md", import.meta.url), "utf8");
const T = shopsim.EVIDENCE.table;

describe("ShopSim export: constants carried over", () => {
  test("evidence table: TAP = CLICKED, STAY = VISITED = BROWSED (one row, bug (b) fixed), BUY = BOUGHT, SEEN = SAW", () => {
    assert.equal(EVIDENCE.seen.pref, T.SAW.pref_weight);
    assert.equal(EVIDENCE.tap.pref, T.CLICKED.pref_weight);
    assert.deepEqual(T.VISITED, T.BROWSED, "ShopSim's two rows are identical, which is why one STAY row replaces them");
    assert.equal(EVIDENCE.stay.pref, T.VISITED.pref_weight);
    assert.deepEqual(EVIDENCE.stay.opinion, { wt: T.VISITED.belief_weight, target: T.VISITED.belief_target });
    assert.equal(EVIDENCE.buy.pref, T.BOUGHT.pref_weight);
    assert.deepEqual(EVIDENCE.buy.opinion, { wt: T.BOUGHT.belief_weight, target: T.BOUGHT.belief_target });
  });
  test("departures: no cart (CARTED has no event), no EXPECTS (SAW/CLICK teach no expectation), no per-tick write cap", () => {
    assert.ok(!("cart" in EVIDENCE) && T.CARTED.pref_weight === 0.5, "tap → stay → buy, no cart (plan)");
    assert.equal(EVIDENCE.seen.opinion, null, "SAW's belief weight fed ShopSim's EXPECTS, which the plan drops");
    assert.equal(EVIDENCE.tap.opinion, null);
    // ShopSim truncated writes past 6 per shopper per tick and lost them (SIM_NOTES §8 bug (c));
    // a shopper here writes at most tap + stay + buy on one ad per day, all applied.
    assert.equal(shopsim.EVIDENCE.MAX_SUBJECTIVE_WRITES_PER_TICK, 6);
  });
  test("blend constants: E cap, epsilon, prior E0, cold start, reference-price smoothing", () => {
    assert.equal(E_MAX, shopsim.EVIDENCE.E_CAP);
    assert.equal(EPSILON, shopsim.EVIDENCE.EPSILON);
    assert.equal(config.shopper.preferenceEvidence, shopsim.EVIDENCE.PRIOR_E0);
    assert.deepEqual({ w: config.shopper.unheldW, E: config.shopper.unheldE }, shopsim.EVIDENCE.COLD_START_PREFERS);
    assert.ok(Math.abs(1 - PRICE_KEEP - shopsim.EVIDENCE.REF_PRICE_ALPHA) < 1e-12);
  });
  test("population draw: w ~ N(prior, 0.08) clipped to [0.05, 0.95] (SIM_NOTES §2)", () => {
    assert.match(notes, /\| prior w \| N\(mean, 0\.08\) \| \[0\.05, 0\.95\] \|/);
    assert.equal(config.shopper.preferenceSd, 0.08);
    assert.deepEqual([config.shopper.preferenceMin, config.shopper.preferenceMax], [0.05, 0.95]);
  });
  test("FUNNEL_BANDS match, and every target sits inside its band", () => {
    for (const k of ["p_click", "bounce_rate", "visit_to_purchase"] as const) assert.deepEqual(FUNNEL_BANDS[k], shopsim.FUNNEL_BANDS[k], k);
    assert.ok(TARGETS.tap >= FUNNEL_BANDS.p_click[0] && TARGETS.tap <= FUNNEL_BANDS.p_click[1]);
    assert.ok(1 - TARGETS.stay >= FUNNEL_BANDS.bounce_rate[0] && 1 - TARGETS.stay <= FUNNEL_BANDS.bounce_rate[1]);
    const v2p = TARGETS.stay * TARGETS.buy;
    assert.ok(v2p >= FUNNEL_BANDS.visit_to_purchase[0] && v2p <= FUNNEL_BANDS.visit_to_purchase[1]);
  });
  test("CPM is ShopSim's $13.88 (SIM_NOTES §5)", () => {
    assert.match(notes, /\*\*\$13\.88 CPM\*\*/);
    assert.equal(config.reward.cpmUsd, 13.88);
  });
  test("the golden chain's shared steps: 0.45 (E 2) → tap 0.476 → stay 0.532 (SIM_NOTES §4)", () => {
    assert.match(notes, /0\.45 \(E 2\) → CLICK 0\.476 → BROWSE 0\.532 → CART 0\.614 → BUY 0\.714/);
    const s = makeShopper(0, loadWorld(), 13);
    s.preferences.high_protein = { w: 0.45, E: 2 };
    applyEvidence(s, "tap", "br_magic_spoon", ["high_protein"]);
    assert.equal(s.preferences.high_protein.w.toFixed(3), "0.476");
    applyEvidence(s, "stay", "br_magic_spoon", ["high_protein"]);
    assert.equal(s.preferences.high_protein.w.toFixed(3), "0.532");
    // ShopSim then applies CART (→ 0.614) before BUY (→ 0.714); with no cart, BUY lands at 0.672.
    applyEvidence(s, "buy", "br_magic_spoon", ["high_protein"]);
    assert.equal(s.preferences.high_protein.w.toFixed(3), "0.672");
  });
});

describe("run manifest", () => {
  test("config_hash is stable, and changes with any setting that shapes a run", async () => {
    const { configHash } = await import("../src/run.js");
    const base = { population: 300, roundsPlanned: 5, perceiverId: "keyword-v1" };
    assert.match(configHash(base), /^[0-9a-f]{64}$/);
    assert.equal(configHash(base), configHash({ ...base }));
    assert.notEqual(configHash(base), configHash({ ...base, population: 150 }));
    assert.notEqual(configHash(base), configHash({ ...base, roundsPlanned: 4 }));
    assert.notEqual(configHash(base), configHash({ ...base, perceiverId: "claude-v1" }));
  });
});

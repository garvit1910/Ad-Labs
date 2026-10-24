import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Bandit, N0, applyFloors } from "../src/bandit.js";
import { TARGETS, bisect, calibrate, fitOffsets, logit, sigmoid } from "../src/calibrate.js";
import type { Impression } from "../src/engine.js";
import { loadWorld } from "../src/fixtures.js";
import { type Candidate, LearningBook, findLearnings, numberFree } from "../src/learnings.js";
import { perceiveAll } from "../src/perceive.js";
import { makeShopper } from "../src/population.js";
import { uniform } from "../src/rng.js";
import { SimRun } from "../src/run.js";
import { fakeJev } from "./fake-jev.js";

const world = loadWorld();
const perceptions = await perceiveAll(world);
const SEED = 13;
const recipes = world.arms.filter((a) => a.strategy !== "control");
const control = world.arms.find((a) => a.strategy === "control")!;
const segIds = world.segments.map((s) => s.segment_id);

// A synthetic impression with only what the bandit and learnings read.
function imp(segment_id: string, arm_id: string, reward: number, extra: Partial<Impression> = {}): Impression {
  return {
    round: 1,
    tick: 3,
    shopper_id: "shp_x",
    segment_id,
    arm_id,
    creative_id: "cr_gen_01",
    in_market: false,
    p_raw: { tap: 0.3, stay: 0.5, buy: 0.2 },
    p_cal: { tap: 0.01, stay: 0.5, buy: 0.04 },
    guard: 1,
    reward_raw: reward,
    reward_cal: reward,
    believes: 0.5,
    objection: "nothing",
    tapped: false,
    stayed: false,
    bought: false,
    lost_to_competitor: false,
    ...extra,
  };
}

describe("calibration: per-gate log-odds offsets by bisection", () => {
  const samples = Array.from({ length: 900 }, (_, i) => ({
    p_raw: {
      tap: 0.1 + 0.6 * uniform(SEED, "tap", i),
      stay: Math.round(100 * uniform(SEED, "stay", i)) / 100, // includes exact 0s and 1s
      buy: 0.1 + 0.4 * uniform(SEED, "buy", i),
    },
    guard: (uniform(SEED, "need", i) < 0.6 ? 1 : 0) as 0 | 1,
  }));
  const fit = fitOffsets(samples);
  test("hits every target: tap 1%, stay 50% of visitors, buy 4% of those who stay", () => {
    assert.ok(Math.abs(fit.p_tap - TARGETS.tap) < 1e-9, String(fit.p_tap));
    assert.ok(Math.abs(fit.bounce_rate - 0.5) < 1e-9);
    assert.ok(Math.abs(fit.p_buy_given_stay - TARGETS.buy) < 1e-9);
    assert.ok(Math.abs(fit.visit_to_purchase - 0.02) < 1e-9);
    assert.deepEqual(fit.in_band, { p_click: true, bounce_rate: true, visit_to_purchase: true });
  });
  test("each gate is conditional on the one before it, and guarded impressions count as 0", () => {
    const tapCal = samples.map((s) => calibrate(s.p_raw.tap, fit.offsets.tap));
    const stayCal = samples.map((s) => calibrate(s.p_raw.stay, fit.offsets.stay));
    const w = tapCal.map((t, i) => t * stayCal[i]!);
    const buy = samples.map((s) => (s.guard ? calibrate(s.p_raw.buy, fit.offsets.buy) : 0));
    const W = w.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(buy.reduce((a, b, i) => a + b * w[i]!, 0) / W - 0.04) < 1e-9);
    // Unweighted, unguarded means would land elsewhere, so the weighting is doing work.
    const naive = samples.reduce((a, s) => a + calibrate(s.p_raw.buy, fit.offsets.buy), 0) / samples.length;
    assert.ok(Math.abs(naive - 0.04) > 0.005);
  });
  test("the shift keeps every pair's order (a monotone map)", () => {
    for (let i = 1; i < samples.length; i++) {
      const [a, b] = [samples[i - 1]!.p_raw.tap, samples[i]!.p_raw.tap];
      assert.equal(Math.sign(calibrate(a, fit.offsets.tap) - calibrate(b, fit.offsets.tap)), Math.sign(a - b));
    }
  });
  test("bisection solves a known case: one probability 0.3 to a 1% mean", () => {
    const b = bisect((x) => sigmoid(logit(0.3) + x), 0.01);
    assert.ok(Math.abs(b - (logit(0.01) - logit(0.3))) < 1e-9);
  });
});

describe("bandit: pooled Gaussian Thompson sampling with floors", () => {
  test("posterior pools toward the arm's cross-segment mean (hand-computed)", () => {
    const b = new Bandit(world.arms, segIds, SEED);
    const [segA, segB] = segIds as [string, string];
    const rs = [
      ...Array.from({ length: 10 }, () => imp(segA, "arm_01", 0.02)),
      ...Array.from({ length: 10 }, () => imp(segB, "arm_01", 0)),
    ];
    b.update(rs, 3);
    // m_a = 0.01; μ = (30·0.01 + 10·0.02) / 40 = 0.0125
    const p = b.posterior(segA, "arm_01");
    assert.ok(Math.abs(p.mean - 0.0125) < 1e-12);
    // sd_pool over 10×0.02 and 10×0: sample sd = sqrt(20·0.0001 / 19); σ = sd / √40
    assert.ok(Math.abs(p.sd - Math.sqrt(0.002 / 19) / Math.sqrt(N0 + 10)) < 1e-12);
    assert.equal(p.n, 10);
    // An unseen arm borrows the mean over all arms (0.01) with n0 pseudo-impressions.
    const unseen = b.posterior(segA, "arm_05");
    assert.ok(Math.abs(unseen.mean - 0.01) < 1e-12);
  });
  test("p_best sums to 1, is reproducible, and favours the better arm", () => {
    const make = () => {
      const b = new Bandit(world.arms, segIds, SEED);
      const rs = world.arms.flatMap((a) =>
        Array.from({ length: 40 }, (_, i) => imp(segIds[0]!, a.arm_id, a.arm_id === "arm_03" ? 0.02 : 0.01 + 0.002 * (i % 3))),
      );
      b.update(rs, 3);
      return b.pBestFor(segIds[0]!);
    };
    const p = make();
    assert.ok(Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.deepEqual(make(), p);
    assert.ok(p.arm_03! > 0.95);
  });
  test("applyFloors: floors met, the rest scaled in proportion, sums to 1", () => {
    const floors = { arm_control: 0.1, a: 0.03, b: 0.03, c: 0.03 };
    const s = applyFloors({ arm_control: 0, a: 0.9, b: 0.1, c: 0 }, floors);
    assert.ok(Math.abs(Object.values(s).reduce((x, y) => x + y, 0) - 1) < 1e-12);
    assert.equal(s.arm_control, 0.1);
    assert.equal(s.c, 0.03);
    assert.ok(Math.abs(s.a! - 0.9 * 0.87) < 1e-12 && Math.abs(s.b! - 0.1 * 0.87) < 1e-12);
  });
  test("per-impression picks land on the floored shares (control ≥ 10%, others ≥ 3%)", () => {
    const b = new Bandit(world.arms, segIds, SEED);
    const seg = segIds[0]!;
    b.update(world.arms.flatMap((a) => Array.from({ length: 60 }, () => imp(seg, a.arm_id, a.arm_id === "arm_02" ? 0.05 : 0.01))), 3);
    const shares = b.sharesFor(seg);
    assert.equal(shares[control.arm_id], 0.1);
    for (const a of recipes) if (a.arm_id !== "arm_02") assert.ok(Math.abs(shares[a.arm_id]! - 0.03) < 1e-12);
    const counts = new Map<string, number>();
    const N = 20_000;
    const shopper = makeShopper(0, world, SEED);
    for (let i = 0; i < N; i++) {
      const s = { ...shopper, shopper_id: `shp_${i}`, segment_id: seg };
      const a = b.policy(s, world.arms, { seed: SEED, round: 1, tick: 4 });
      counts.set(a.arm_id, (counts.get(a.arm_id) ?? 0) + 1);
    }
    for (const a of world.arms) {
      const got = (counts.get(a.arm_id) ?? 0) / N;
      assert.ok(Math.abs(got - shares[a.arm_id]!) < 0.01, `${a.arm_id}: ${got} vs ${shares[a.arm_id]}`);
    }
  });
});

describe("learnings: templates, number-free directives, versioning", () => {
  test("numberFree strips every number", () => {
    assert.equal(numberFree("About $12.50 per order (85% chance), 1,200 shoppers."), "About per order (chance), shoppers.");
  });
  test("winner, objection and claim_doubt fire at their thresholds; directives carry no digits", () => {
    const seg = "seg_taste_skeptic";
    const b = new Bandit(world.arms, segIds, SEED);
    const rs = [
      ...Array.from({ length: 120 }, (_, i) => imp(seg, "arm_11", 0.004 + 0.0001 * (i % 5), { objection: "taste_doubt", believes: 0.3, creative_id: "cr_gen_11" })),
      ...world.arms.filter((a) => a.arm_id !== "arm_11").flatMap((a) => Array.from({ length: 40 }, () => imp(seg, a.arm_id, 0.001))),
    ];
    b.update(rs, 5);
    const found = findLearnings({ world, arms: world.arms, bandit: b, impressions: rs, mainConcept: () => "taste" });
    const kinds = new Map(found.filter((c) => c.segment_id === seg).map((c) => [c.kind, c]));
    const winner = kinds.get("winner")!;
    assert.equal(winner.arm_id, "arm_11");
    assert.match(winner.statement, /^For taste skeptic shoppers, taste indulgence × testimonial leads: about \$\d+ per order vs \$\d+ for Magic Spoon's current ads \(\d+% chance it's truly best\)\.$/);
    assert.equal(winner.directive, "For taste skeptic shoppers, keep leading with taste indulgence through a testimonial hook.");
    // 120 of 560 page calls hesitate over taste; the rest say "nothing", which never counts.
    assert.equal(kinds.get("objection")!.statement, "Taste skeptic shoppers mostly hesitate over taste doubts (21% of page visits).");
    assert.equal(kinds.get("objection")!.directive, "Address taste doubts early for taste skeptic shoppers.");
    // believes: 120 × 0.3 + 440 × 0.5 over 560 = 0.457, above 0.40, so no claim_doubt.
    assert.equal(kinds.get("claim_doubt"), undefined);
    for (const c of found) assert.ok(!/\d/.test(c.directive), c.directive);
  });
  test("claim_doubt: mean believes under 0.40 over at least 50 feed calls", () => {
    const seg = "seg_keto_low_carb";
    const b = new Bandit(world.arms, segIds, SEED);
    const doubt = Array.from({ length: 50 }, () => imp(seg, "arm_02", 0.001, { believes: 0.39 }));
    const found = findLearnings({ world, arms: world.arms, bandit: b, impressions: doubt, mainConcept: () => "low_carb_keto" });
    const c = found.find((x) => x.kind === "claim_doubt")!;
    assert.equal(c.statement, "Keto low-carb shoppers don't believe low carb or keto claims (only 39% do).");
    assert.equal(c.directive, "Keto low-carb shoppers doubt low carb or keto claims: back them with a concrete brand fact or drop them.");
    const few = findLearnings({ world, arms: world.arms, bandit: b, impressions: doubt.slice(1), mainConcept: () => "low_carb_keto" });
    assert.ok(!few.some((x) => x.kind === "claim_doubt"), "49 feed calls are not enough");
  });
  test("a new version closes the old one; a learning that stops firing is closed; nothing is deleted", () => {
    const book = new LearningBook("run_t");
    const c = (statement: string): Candidate => ({
      segment_id: "seg_keto_low_carb",
      arm_id: null,
      kind: "objection",
      subject: "top",
      statement,
      directive: "Address price early for keto low-carb shoppers.",
      evidence: {},
    });
    assert.equal(book.apply(0, [c("A (10% of page visits).")]).opened.length, 1);
    assert.deepEqual(book.apply(1, [c("A (10% of page visits).")]), { opened: [], closed: [] });
    const v2 = book.apply(2, [c("A (12% of page visits).")]);
    assert.deepEqual(v2.closed.map((l) => [l.learning_id, l.valid_to_round]), [["lrn_keto_low_carb_objection_top_v1", 2]]);
    assert.deepEqual(v2.opened.map((l) => [l.learning_id, l.valid_from_round, l.source]), [["lrn_keto_low_carb_objection_top_v2", 2, "simulated"]]);
    const gone = book.apply(3, []);
    assert.deepEqual(gone.closed.map((l) => l.learning_id), ["lrn_keto_low_carb_objection_top_v2"]);
    assert.equal(book.all.length, 2);
    assert.deepEqual(book.live(), []);
  });
});

describe("planted winner (stub Jev)", () => {
  // The stub likes the planted ad only for the segment it was written for, the way Jev should.
  const seg = world.segments.find((s) => s.segment_id === "seg_taste_skeptic")!;
  const isSkeptic = (state: string) => state.includes(seg.description);
  const jev = fakeJev({}, undefined, (state, name, q) => {
    const plantedAd = state.includes('THEY TAPPED\nMagic Spoon: "I was sure healthy cereal');
    if (name.startsWith("tap_")) return isSkeptic(state) && String(q.instructions).includes("taste like gravel") ? 0.7 : 0.3;
    if (name === "stays") return isSkeptic(state) && plantedAd ? 0.8 : 0.5;
    if (name === "buys") return isSkeptic(state) && plantedAd ? 0.5 : 0.25;
    if (name === "believes") return 0.5;
    return undefined;
  });

  test("by round 3 the planted recipe gets more than 50% of its segment, and the run is reproducible", async () => {
    const play = async () => {
      const run = new SimRun(world, jev, perceptions, { run_id: "run_t", seed: SEED, population: 300, roundsPlanned: 3 });
      await run.calibrate();
      const shares: number[] = [];
      const gens = [];
      for (let r = 0; r <= 3; r++) {
        const rep = await run.runRound(r);
        const imps = rep.days.flatMap((d) => d.impressions).filter((i) => i.segment_id === seg.segment_id);
        shares.push(imps.filter((i) => i.arm_id === "arm_11").length / imps.length);
        gens.push(rep.generation);
      }
      return { run, shares, gens };
    };
    const { run, shares, gens } = await play();
    assert.ok(shares[0]! < 0.2, `warm-up shows every arm equally: ${shares[0]}`);
    assert.ok(shares[3]! > 0.5, `round 3 share ${shares[3]}`);
    assert.ok(shares[3]! <= 0.6 + 0.08, "the floors cap any arm near 60%");
    assert.ok(run.bandit.pBestFor(seg.segment_id).arm_11! > 0.9);
    // It also wins the learnings and the generation request.
    assert.ok(run.book.live().some((l) => l.kind === "winner" && l.arm_id === "arm_11" && l.segment_id === seg.segment_id));
    assert.ok(gens[2]!.arms.some((a) => a.arm_id === "arm_11" && a.segment_ids.includes(seg.segment_id)));
    assert.equal(gens[3], null, "no generation after the last planned round");
    for (const g of gens.slice(0, 3)) {
      assert.ok(g!.arms.length <= 3 && g!.arms.every((a) => a.arm_id !== control.arm_id));
      assert.equal(new Set(g!.arms.map((a) => a.arm_id)).size, g!.arms.length);
    }
    // Offsets are fitted once on the warm-up and frozen; every decision stores raw and calibrated.
    const again = await play();
    assert.deepEqual(again.shares, shares);
    assert.deepEqual(again.run.fit.offsets, run.fit.offsets);
    const one = run.impressions[0]!;
    assert.ok(Math.abs(one.p_cal.tap - calibrate(one.p_raw.tap, run.fit.offsets.tap)) < 1e-12);
  });
});

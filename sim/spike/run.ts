import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, loadEnv, SIM_ROOT } from "../src/config.js";
import type { Creative } from "../src/contract.js";
import { loadWorld } from "../src/fixtures.js";
import { JevClient } from "../src/jev.js";
import { type Shape, type TapResult, askTap, permutations } from "./shapes.js";
import { type SpikeState, buildStates, renderPageState } from "./states.js";

// B1 tests 1-4 on hand-built states, for both feed shapes. Every call goes through the cache,
// so a re-run is free and prints identical numbers. Usage: npm run sim:spike

loadEnv();
const world = loadWorld();
const client = new JevClient();
const { base, memory } = buildStates(world);
const SHAPES: Shape[] = ["choice", "noul"];
const ad = (id: string): Creative => world.creatives.find((c) => c.creative_id === id)!;

// Fixed, generic competitor neighbours, so only our ad and the state vary.
const NEIGHBOURS = [ad("cr_cc_live_2"), ad("cr_tw_live_1")];
const LOW_CARB = ad("cr_gen_02");
const CHILDHOOD = ad("cr_gen_04");
const PROTEIN = ad("cr_gen_03");
const segmentAd = (s: SpikeState) => world.creatives.find((c) => c.origin === "generated" && c.segment_id === s.shopper.segment_id)!;

const SENSITIVITY_MIN_RATIO = 1.5;
const ORDER_MAX_REL_DEV = 0.2;
// Relative movement is meaningless on near-zero probabilities (0.00 vs 0.01 is "100%"), so
// the order rule is judged on ads whose mean P(tap) is at least this.
const ORDER_MIN_MEAN = 0.02;

const latencies: number[] = [];
let fresh = 0;
let cached = 0;
function track(r: TapResult | { latencyMs: number; cacheHit: boolean }) {
  if (r.cacheHit) cached++;
  else {
    fresh++;
    latencies.push(r.latencyMs);
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

// P(tap) for every creative across all 6 orders of the three ads, plus P(tap) by position.
async function allOrders(shape: Shape, s: SpikeState, ads: Creative[]) {
  const perms = permutations(ads);
  const results = await Promise.all(perms.map((p) => askTap(client, shape, s, p, world)));
  results.forEach(track);
  const byCreative: Record<string, number[]> = {};
  const byPosition: number[][] = ads.map(() => []);
  results.forEach((r, i) => {
    perms[i]!.forEach((c, pos) => {
      (byCreative[c.creative_id] ??= []).push(r.pTap[c.creative_id]!);
      byPosition[pos]!.push(r.pTap[c.creative_id]!);
    });
  });
  const pNone = results.map((r) => r.pNone).filter((x): x is number => x !== null);
  return { byCreative, byPosition, pNone };
}

function orderStats(byCreative: Record<string, number[]>) {
  return Object.entries(byCreative).map(([id, ps]) => {
    const m = mean(ps);
    const maxRelDev = m > 0 ? Math.max(...ps.map((p) => Math.abs(p - m))) / m : 0;
    return { creative_id: id, mean: round(m), min: round(Math.min(...ps)), max: round(Math.max(...ps)), maxRelDev: round(maxRelDev, 3), judged: m >= ORDER_MIN_MEAN };
  });
}

const results: Record<string, unknown> = { model: config.jev.model, neighbours: NEIGHBOURS.map((c) => c.creative_id) };

for (const shape of SHAPES) {
  console.log(`\n================ shape: ${shape} ================`);

  // Test 2 (run first: its calls are reused by tests 1 and 4) — option order.
  const order = await Promise.all(
    base.map(async (s) => {
      const ours = segmentAd(s);
      const o = await allOrders(shape, s, [ours, ...NEIGHBOURS]);
      return { state: s.id, ours: ours.creative_id, stats: orderStats(o.byCreative), byPosition: o.byPosition.map((xs) => round(mean(xs))), pNoneMean: o.pNone.length ? round(mean(o.pNone)) : null, pOurs: round(mean(o.byCreative[ours.creative_id]!)) };
    }),
  );
  const judged = order.flatMap((o) => o.stats.filter((x) => x.judged));
  const worst = judged.reduce((a, b) => (b.maxRelDev > a.maxRelDev ? b : a), judged[0]!);
  const orderPass = judged.every((x) => x.maxRelDev < ORDER_MAX_REL_DEV);
  const positionMeans = [0, 1, 2].map((i) => round(mean(order.map((o) => o.byPosition[i]!))));
  console.log("\nTest 2 — order (max |p - mean| / mean over 6 orders, ads with mean >= 0.02)");
  for (const o of order) {
    console.log(`  ${o.state.padEnd(26)} ` + o.stats.map((x) => `${x.creative_id}=${x.mean.toFixed(3)}±${(x.maxRelDev * 100).toFixed(0)}%${x.judged ? "" : "(skip)"}`).join("  "));
  }
  console.log(`  mean P(tap) by position 1/2/3: ${positionMeans.join(" / ")}`);
  console.log(`  worst: ${worst.creative_id} ${(worst.maxRelDev * 100).toFixed(1)}%  ->  ${orderPass ? "PASS" : "FAIL"} (limit 20%), ${judged.filter((x) => x.maxRelDev >= ORDER_MAX_REL_DEV).length}/${judged.length} judged ads over`);

  // Test 1 — sensitivity. (b) our ad alone among the fixed neighbours, as the sim shows it;
  // (a) both of our ads head to head with one neighbour.
  const sens = await Promise.all(
    base
      .filter((s) => s.shopper.segment_id === "seg_keto_low_carb" || s.shopper.segment_id === "seg_nostalgic_adult")
      .map(async (s) => {
        const keto = s.shopper.segment_id === "seg_keto_low_carb";
        const [fit, other] = keto ? [LOW_CARB, CHILDHOOD] : [CHILDHOOD, LOW_CARB];
        const pFit = mean((await allOrders(shape, s, [fit, ...NEIGHBOURS])).byCreative[fit.creative_id]!);
        const pOther = mean((await allOrders(shape, s, [other, ...NEIGHBOURS])).byCreative[other.creative_id]!);
        const h2h = (await allOrders(shape, s, [fit, other, NEIGHBOURS[1]!])).byCreative;
        const hFit = mean(h2h[fit.creative_id]!);
        const hOther = mean(h2h[other.creative_id]!);
        return { state: s.id, fit: fit.creative_id, pFit: round(pFit), pOther: round(pOther), ratio: round(pFit / pOther, 2), h2hFit: round(hFit), h2hOther: round(hOther), h2hRatio: round(hFit / hOther, 2) };
      }),
  );
  const sensPass = sens.every((x) => x.ratio >= SENSITIVITY_MIN_RATIO);
  console.log("\nTest 1 — sensitivity (fitting ad / other ad, mean over 6 orders)");
  for (const x of sens) {
    console.log(`  ${x.state.padEnd(26)} alone: ${x.pFit.toFixed(3)} vs ${x.pOther.toFixed(3)} = ${x.ratio}x   head-to-head: ${x.h2hFit.toFixed(3)} vs ${x.h2hOther.toFixed(3)} = ${x.h2hRatio}x`);
  }
  console.log(`  ->  ${sensPass ? "PASS" : "FAIL"} (need >= 1.5x alone)`);

  // Test 3 — memory: four protein ads this week should lower the protein ad's tap chance.
  const mem = await Promise.all(
    memory.map(async ({ without, with: withMem }) => {
      const p0 = mean((await allOrders(shape, without, [PROTEIN, ...NEIGHBOURS])).byCreative[PROTEIN.creative_id]!);
      const p1 = mean((await allOrders(shape, withMem, [PROTEIN, ...NEIGHBOURS])).byCreative[PROTEIN.creative_id]!);
      return { state: without.id, without: round(p0), with: round(p1), change: round(p1 / p0 - 1, 3) };
    }),
  );
  const memPass = mem.every((x) => x.with < x.without);
  console.log("\nTest 3 — memory (P(tap protein ad), without -> with 4 protein ads seen)");
  for (const x of mem) console.log(`  ${x.state.padEnd(26)} ${x.without.toFixed(3)} -> ${x.with.toFixed(3)} (${(x.change * 100).toFixed(0)}%)`);
  console.log(`  ->  ${memPass ? "PASS" : "FAIL"} (must fall in every pair)`);

  // Test 4 (feed half) — need should raise the tap on our ad too; reported, not judged.
  const feedNeed = world.segments.map((seg) => {
    const off = order.find((o) => o.state === seg.segment_id)!;
    const on = order.find((o) => o.state === `${seg.segment_id}+need`)!;
    return { segment: seg.segment_id, off: off.pOurs, on: on.pOurs };
  });
  console.log("\nTest 4 (feed) — P(tap our ad), not shopping -> shopping now");
  for (const x of feedNeed) console.log(`  ${x.segment.padEnd(26)} ${x.off.toFixed(3)} -> ${x.on.toFixed(3)}`);

  results[shape] = { order: { pass: orderPass, worst, positionMeans, perState: order }, sensitivity: { pass: sensPass, perState: sens }, memory: { pass: memPass, perState: mem }, feedNeed };
}

// Test 4 — need on the page call: "shopping for cereal right now" should raise P(buy).
// One page call per state; the page questions don't depend on the feed shape.
const OBJECTIONS = {
  price: "The price is more than they want to pay.",
  taste_doubt: "They doubt it tastes good.",
  trust: "They don't trust the brand or its claims.",
  not_now: "They don't need cereal right now.",
  other_brand: "They'd rather buy another brand.",
  nothing: "Nothing is holding them back.",
};
const pageQuestions = {
  stays: { type: "noul" as const, instructions: "Does the shopper look through this page instead of leaving within a few seconds?" },
  buys: { type: "noul" as const, instructions: "If they stay, do they buy on this visit?" },
  objection: { type: "choice" as const, instructions: "What is the main thing holding them back, if anything?", criteria: OBJECTIONS },
};
const page = await Promise.all(
  world.segments.map(async (seg) => {
    const ask = async (s: SpikeState) => {
      const r = await client.ask(renderPageState(s, segmentAd(s), world), pageQuestions);
      track(r);
      return { stays: r.answers.stays.noul, buys: r.answers.buys.noul, objection: r.answers.objection.choice, objectionP: r.answers.objection.probabilities };
    };
    const off = await ask(base.find((s) => s.id === seg.segment_id)!);
    const on = await ask(base.find((s) => s.id === `${seg.segment_id}+need`)!);
    return { segment: seg.segment_id, off, on };
  }),
);
const needPass = page.every((x) => x.on.buys > x.off.buys);
console.log("\n================ page call ================");
console.log("Test 4 — need (P(buy | stay), not shopping -> shopping now; P(stay); main objection)");
for (const x of page) {
  console.log(`  ${x.segment.padEnd(22)} buys ${x.off.buys.toFixed(2)} -> ${x.on.buys.toFixed(2)}   stays ${x.off.stays.toFixed(2)} -> ${x.on.stays.toFixed(2)}   objection ${x.off.objection} -> ${x.on.objection}`);
}
console.log(`  ->  ${needPass ? "PASS" : "FAIL"} (P(buy) must rise in every pair)`);
results.page = { pass: needPass, perSegment: page };

latencies.sort((a, b) => a - b);
const pct = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? null;
results.calls = { fresh, cached, p50_ms: pct(0.5), p95_ms: pct(0.95), max_ms: latencies.at(-1) ?? null };
console.log(`\ncalls: ${fresh} fresh, ${cached} from cache; fresh latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms`);

const outDir = join(SIM_ROOT, "spike", "results");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "tests.json"), JSON.stringify(results, null, 2));
console.log(`results: ${join(outDir, "tests.json")}`);
client.close();

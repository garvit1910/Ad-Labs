import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config, loadEnv } from "./config.js";
import { loadWorld } from "./fixtures.js";
import { type JevAttempt, JevClient } from "./jev.js";
import { PerceptionStore, keywordPerceiver, perceiveAll } from "./perceive.js";
import { type RoundReport, SimRun } from "./run.js";

// sim run: the warm-up (round 0) plus N bandit rounds on the fixtures, in memory.
// Usage: npm run sim:run -- --rounds 5 --fixtures [--json] [--seed 13] [--population 300] [--no-cache]
//
// stdout carries only results that depend on Jev's answers and the seed, so two runs with a warm
// cache print identical output. Timings and cache stats go to stderr.

const { values: args } = parseArgs({
  options: {
    rounds: { type: "string", default: String(config.run.roundsPlanned) },
    fixtures: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    seed: { type: "string", default: String(config.run.seed) },
    population: { type: "string", default: String(config.run.population) },
    "no-cache": { type: "boolean", default: false },
  },
});

if (!args.fixtures) {
  console.error("Only --fixtures runs exist until B4 reads A's rows from SpacetimeDB.");
  process.exit(2);
}

loadEnv();
const started = performance.now();
const roundsPlanned = Number(args.rounds);
const seed = Number(args.seed);
const population = Number(args.population);
const world = loadWorld();
const plantedPath = join(config.paths.fixtures, "planted.json");
const planted: { creative_id: string; arm_id: string; segment_id: string } | null = existsSync(plantedPath)
  ? JSON.parse(readFileSync(plantedPath, "utf8"))
  : null;

const store = new PerceptionStore();
const perceptions = await perceiveAll(world, keywordPerceiver, store);
store.close();

const attempts: JevAttempt[] = [];
const client = new JevClient({ cachePath: args["no-cache"] ? null : config.paths.cacheDb, onAttempt: (a) => attempts.push(a) });
const run_id = `run_fixtures_s${seed}_p${population}`;
const run = new SimRun(world, client, perceptions, { run_id, seed, population, roundsPlanned });

const segName = new Map(world.segments.map((s) => [s.segment_id, s.name]));
const armName = new Map(world.arms.map((a) => [a.arm_id, a.strategy === "control" ? "control" : `${a.angle} × ${a.hook}`]));
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const money = (x: number | null) => (x === null ? "n/a" : `$${x.toFixed(2)}`);

function printRound(r: RoundReport) {
  const rep = run.report(r);
  if (args.json) {
    console.log(JSON.stringify(rep, null, 2));
    return;
  }
  const lines = [
    `\n== round ${r.round}${r.round === 0 ? " (warm-up: every arm equally)" : ""}, ticks ${rep.ticks.join("-")} ==`,
    `${rep.impressions} impressions: ${rep.taps} taps, ${rep.stays} stays, ${rep.buys} buys; ` +
      `${rep.lost_to_competitor} lost to a competitor; ${rep.budget_guarded} budget-guarded`,
    `expected orders per impression ${rep.mean_reward_cal.toFixed(6)} ` +
      `(cost per order ${money(rep.mean_reward_cal > 0 ? config.reward.cpmUsd / 1000 / rep.mean_reward_cal : null)})`,
    `calibrated funnel: P(tap) ${pct(rep.funnel_cal.p_tap, 2)}, bounce ${pct(rep.funnel_cal.bounce_rate, 1)}, ` +
      `P(buy | stay) ${pct(rep.funnel_cal.p_buy_given_stay, 2)}, visit→purchase ${pct(rep.funnel_cal.visit_to_purchase, 2)}`,
    "leaderboard (cost per order from the posterior mean, ±2 sd range; share = this round's impressions):",
  ];
  for (const seg of rep.leaderboard) {
    lines.push(`  ${segName.get(seg.segment_id)} (${seg.impressions_this_round} this round)`);
    const row = (a: (typeof seg.top)[number], tag = "") =>
      `    ${tag}${a.arm_id.padEnd(12)} ${(armName.get(a.arm_id) ?? "").padEnd(34)} ${money(a.cpo_usd).padStart(8)} ` +
      `[${money(a.cpo_range_usd[0] ?? null)}–${money(a.cpo_range_usd[1] ?? null)}]  p_best ${pct(a.p_best).padStart(4)}  ` +
      `share ${pct(a.share_this_round).padStart(4)}  n ${a.impressions}`;
    for (const a of seg.top) lines.push(row(a));
    if (seg.control && !seg.top.some((a) => a.arm_id === seg.control!.arm_id)) lines.push(row(seg.control));
  }
  lines.push(`learnings: ${rep.learnings.opened.length} new, ${rep.learnings.closed.length} closed, ${rep.learnings.live} live`);
  for (const l of rep.learnings.opened) lines.push(`  + ${l.learning_id}\n      ${l.statement}\n      directive: ${l.directive}`);
  for (const id of rep.learnings.closed) lines.push(`  - ${id}`);
  if (rep.generation) {
    lines.push(
      `generate_creatives: ${rep.generation.arms.map((a) => `${a.arm_id} for ${a.segment_ids.join(", ")}`).join("; ")}; ` +
        `${rep.generation.learning_ids.length} learning ids`,
    );
  }
  if (planted) {
    const imps = r.days.flatMap((d) => d.impressions).filter((i) => i.segment_id === planted.segment_id);
    const share = imps.length ? imps.filter((i) => i.arm_id === planted.arm_id).length / imps.length : 0;
    const p = run.bandit.pBestFor(planted.segment_id)[planted.arm_id] ?? 0;
    lines.push(`planted ${planted.creative_id} (${planted.arm_id}) in ${planted.segment_id}: share ${pct(share, 1)} this round, p_best ${pct(p, 1)}`);
  }
  console.log(lines.join("\n"));
}

try {
  const fit = await run.calibrate();
  if (!args.json) {
    console.log(`run ${run_id}: warm-up + ${roundsPlanned} rounds, ${population} shoppers, seed ${seed}`);
    console.log(
      `calibration (fitted on ${fit.n} warm-up impressions): offsets tap ${fit.offsets.tap.toFixed(3)}, ` +
        `stay ${fit.offsets.stay.toFixed(3)}, buy ${fit.offsets.buy.toFixed(3)}`,
    );
    console.log(
      `  P(tap) ${pct(fit.p_tap, 2)} [band 0.5–2%: ${fit.in_band.p_click ? "in" : "OUT"}], ` +
        `bounce ${pct(fit.bounce_rate, 1)} [45–55%: ${fit.in_band.bounce_rate ? "in" : "OUT"}], ` +
        `P(buy | stay) ${pct(fit.p_buy_given_stay, 2)}, visit→purchase ${pct(fit.visit_to_purchase, 2)} ` +
        `[1–3%: ${fit.in_band.visit_to_purchase ? "in" : "OUT"}]`,
    );
  }
  console.error(`calibration probe: ${attempts.length} HTTP attempts, ${((performance.now() - started) / 1000).toFixed(1)} s`);

  for (let round = 0; round <= roundsPlanned; round++) {
    const t0 = performance.now();
    const before = attempts.length;
    const r = await run.runRound(round);
    printRound(r);
    const decisions = r.days.flatMap((d) => d.decisions);
    console.error(
      `round ${round}: ${decisions.length} calls, ${decisions.filter((d) => d.cache_hit).length} cached, ` +
        `${attempts.length - before} HTTP attempts, ${Math.round(performance.now() - t0)} ms`,
    );
  }

  if (!args.json) {
    const last = run.armStats(roundsPlanned);
    console.log(`\n== arm stats after round ${roundsPlanned} (run so far) ==`);
    console.log(`  ${"segment".padEnd(18)} ${"arm".padEnd(12)} ${"n".padStart(5)} ${"post_mean".padStart(10)} ${"cost/order".padStart(10)} ${"p_best".padStart(7)}`);
    for (const s of last) {
      console.log(
        `  ${(segName.get(s.segment_id) ?? s.segment_id).padEnd(18)} ${s.arm_id.padEnd(12)} ${String(s.impressions).padStart(5)} ` +
          `${s.post_mean.toFixed(6).padStart(10)} ${money(s.est_cost_per_order_usd).padStart(10)} ${pct(s.p_best, 1).padStart(7)}`,
      );
    }
    console.log(`\n== live learnings (${run.book.live().length}) ==`);
    for (const l of run.book.live()) console.log(`  ${l.learning_id} (from round ${l.valid_from_round})\n    ${l.statement}\n    directive: ${l.directive}`);
  }
  const retries = attempts.filter((a) => a.attempt > 0).length;
  console.error(`total ${((performance.now() - started) / 1000).toFixed(1)} s, ${attempts.length} HTTP attempts, ${retries} retries`);
} finally {
  client.close();
}

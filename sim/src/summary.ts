import type { Offsets } from "./calibrate.js";
import { config } from "./config.js";
import type { DayResult, Impression } from "./engine.js";
import { OBJECTIONS, type Objection } from "./feed.js";
import type { World } from "./fixtures.js";

// The one-round JSON summary B2 prints. Everything in it comes from Jev's answers and the
// seeded dice, never from timings or cache hits, so a warm-cache re-run prints it byte for
// byte. B4 turns it into the round row's summary for A's ASI:One cards.

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function rates(imps: Impression[]) {
  return {
    impressions: imps.length,
    taps: imps.filter((i) => i.tapped).length,
    stays: imps.filter((i) => i.stayed).length,
    buys: imps.filter((i) => i.bought).length,
    lost_to_competitor: imps.filter((i) => i.lost_to_competitor).length,
    mean_p_raw: {
      tap: round4(mean(imps.map((i) => i.p_raw.tap))),
      stay: round4(mean(imps.map((i) => i.p_raw.stay))),
      buy: round4(mean(imps.map((i) => i.p_raw.buy))),
    },
    mean_believes: round4(mean(imps.map((i) => i.believes))),
    // Expected orders per impression, before and after calibration.
    mean_reward_raw: round6(mean(imps.map((i) => i.reward_raw))),
    mean_reward_cal: round6(mean(imps.map((i) => i.reward_cal))),
  };
}

function objectionShares(imps: Impression[]): Record<Objection, number> {
  const out = Object.fromEntries(Object.keys(OBJECTIONS).map((k) => [k, 0])) as Record<Objection, number>;
  for (const i of imps) out[i.objection]++;
  for (const k of Object.keys(out) as Objection[]) out[k] = round4(imps.length ? out[k] / imps.length : 0);
  return out;
}

export function roundSummary(
  world: World,
  run: { run_id: string; seed: number; population: number; offsets: Offsets },
  days: DayResult[],
) {
  const imps = days.flatMap((d) => d.impressions);
  const calls = days.reduce((n, d) => n + d.decisions.length, 0);
  const inputTokens = days.reduce((n, d) => n + d.inputTokens, 0);
  const group = <K extends string>(key: (i: Impression) => K) => {
    const m = new Map<K, Impression[]>();
    for (const i of imps) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
    return m;
  };
  const byArm = group((i) => i.arm_id);
  const bySegment = group((i) => i.segment_id);
  return {
    run_id: run.run_id,
    round: days[0]?.round ?? null,
    ticks: days.map((d) => d.tick),
    seed: run.seed,
    population: run.population,
    calibration: run.offsets,
    in_market_impressions: imps.filter((i) => i.in_market).length,
    budget_guarded: imps.filter((i) => i.guard === 0).length,
    ...rates(imps),
    objections: objectionShares(imps),
    by_arm: world.arms
      .filter((a) => byArm.has(a.arm_id))
      .map((a) => ({ arm_id: a.arm_id, strategy: a.strategy, angle: a.angle, hook: a.hook, ...rates(byArm.get(a.arm_id)!) })),
    by_segment: world.segments
      .filter((s) => bySegment.has(s.segment_id))
      .map((s) => {
        const si = bySegment.get(s.segment_id)!;
        return { segment_id: s.segment_id, ...rates(si), objections: objectionShares(si) };
      }),
    jev: {
      model: config.jev.model,
      calls,
      input_tokens: inputTokens,
      cost_usd: round4((inputTokens / 1e6) * config.jev.usdPerMillionInputTokens),
    },
  };
}

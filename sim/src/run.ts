import { Bandit } from "./bandit.js";
import { type FitReport, ZERO_OFFSETS, fitOffsets } from "./calibrate.js";
import { config } from "./config.js";
import { type ArmPolicy, type Asker, type DayResult, Engine, type Impression, balancedPolicy } from "./engine.js";
import type { World } from "./fixtures.js";
import { type Learning, LearningBook, costPerOrder, findLearnings } from "./learnings.js";
import type { Perception } from "./perceive.js";
import { roundSummary } from "./summary.js";

// One simulation run: the warm-up round fits calibration, then the bandit allocates rounds
// 1..N ("Reward, bandit and learnings" > "One round, end to end").
//
// Calibration needs the warm-up's raw answers before the warm-up's dice can be rolled with
// calibrated values (DECISIONS D50), so the warm-up is asked twice: a probe pass with zero
// offsets whose shoppers are thrown away, then the real round 0 on fresh shoppers with the
// fitted offsets. Day 0 of the real pass reads exactly the probe's states, so it comes from
// the cache.

export type RunOptions = { run_id: string; seed: number; population: number; roundsPlanned: number };

// The contract's arm_stat row. A full set is produced at the end of every sim day (B4 writes
// each day's); impressions and mean_reward cover the run so far, like the posterior (D52).
export type ArmStat = {
  run_id: string;
  round: number;
  segment_id: string;
  arm_id: string;
  impressions: number;
  mean_reward: number | null;
  post_mean: number;
  post_sd: number;
  p_best: number;
  est_cost_per_order_usd: number | null;
};

// The generate_creatives task payload (the task board, B4).
export type GenerationRequest = {
  run_id: string;
  round: number;
  arms: { arm_id: string; segment_ids: string[] }[];
  n_per_arm: number;
  learning_ids: string[];
};

export type RoundReport = {
  round: number;
  days: DayResult[];
  // One full set per sim day; the last is the round's.
  dailyArmStats: ArmStat[][];
  armStats: ArmStat[];
  opened: Learning[];
  closed: Learning[];
  generation: GenerationRequest | null;
};

export const MAX_GENERATION_ARMS = 3;

export class SimRun {
  engine!: Engine;
  bandit!: Bandit;
  fit!: FitReport;
  // The probe pass's Jev usage, which no round's summary includes.
  probe = { calls: 0, input_tokens: 0 };
  readonly book: LearningBook;
  readonly impressions: Impression[] = [];

  constructor(
    readonly world: World,
    private jev: Asker,
    private perceptions: Map<string, Perception>,
    readonly opts: RunOptions,
  ) {
    this.book = new LearningBook(opts.run_id);
  }

  // The warm-up probe: every arm equally, zero offsets, then bisection per gate.
  async calibrate(): Promise<FitReport> {
    const { run_id, seed, population } = this.opts;
    const probe: Engine = new Engine(this.world, this.jev, this.perceptions, {
      run_id,
      seed,
      population,
      offsets: ZERO_OFFSETS,
      policy: balancedPolicy(() => probe.shoppers),
    });
    const days = await probe.runRound(0);
    this.probe = {
      calls: days.reduce((n, d) => n + d.decisions.length, 0),
      input_tokens: days.reduce((n, d) => n + d.inputTokens, 0),
    };
    const fit = fitOffsets(days.flatMap((d) => d.impressions));
    Object.freeze(fit.offsets);
    this.fit = Object.freeze(fit);
    this.bandit = new Bandit(probe.arms, this.world.segments.map((s) => s.segment_id), seed);
    // Round 0 deals every arm equally; from round 1 the bandit picks.
    const warmUp = balancedPolicy(() => this.engine.shoppers);
    const policy: ArmPolicy = (shopper, arms, ctx) =>
      ctx.round === 0 ? warmUp(shopper, arms, ctx) : this.bandit.policy(shopper, arms, ctx);
    this.engine = new Engine(this.world, this.jev, this.perceptions, { run_id, seed, population, offsets: this.fit.offsets, policy });
    return this.fit;
  }

  async runRound(round: number): Promise<RoundReport> {
    if (!this.engine) throw new Error("calibrate() before running rounds");
    const days: DayResult[] = [];
    const dailyArmStats: ArmStat[][] = [];
    for (const tick of this.engine.ticksOf(round)) {
      const day = await this.engine.runDay(round, tick);
      // End of day: the day's rows (B4 batches them to SpacetimeDB), then the bandit update and
      // the refreshed arm stats.
      this.bandit.update(day.impressions, tick);
      this.impressions.push(...day.impressions);
      days.push(day);
      dailyArmStats.push(this.armStats(round));
    }
    const candidates = findLearnings({
      world: this.world,
      arms: this.engine.arms,
      bandit: this.bandit,
      impressions: this.impressions,
      mainConcept: (id) => this.engine.claimed(this.world.creatives.find((c) => c.creative_id === id)!)[0] ?? null,
    });
    const { opened, closed } = this.book.apply(round, candidates);
    return {
      round,
      days,
      dailyArmStats,
      armStats: dailyArmStats.at(-1)!,
      opened,
      closed,
      generation: round < this.opts.roundsPlanned ? this.generation(round) : null,
    };
  }

  armStats(round: number): ArmStat[] {
    const rows: ArmStat[] = [];
    for (const seg of this.world.segments) {
      const pBest = this.bandit.pBestFor(seg.segment_id);
      for (const arm of this.engine.arms) {
        const p = this.bandit.posterior(seg.segment_id, arm.arm_id);
        rows.push({
          run_id: this.opts.run_id,
          round,
          segment_id: seg.segment_id,
          arm_id: arm.arm_id,
          impressions: p.n,
          mean_reward: p.cellMean,
          post_mean: p.mean,
          post_sd: p.sd,
          p_best: pBest[arm.arm_id] ?? 0,
          est_cost_per_order_usd: costPerOrder(p.mean),
        });
      }
    }
    return rows;
  }

  // Step 4: the top recipe per segment by p_best (the control has no recipe to vary), deduped,
  // at most 3, strongest first, with the live learnings for those segments.
  generation(round: number): GenerationRequest {
    const tops = new Map<string, { segment_ids: string[]; p: number }>();
    for (const seg of this.world.segments) {
      const pBest = this.bandit.pBestFor(seg.segment_id);
      const recipes = this.engine.arms.filter((a) => a.strategy !== "control");
      const top = recipes.reduce((best, a) => ((pBest[a.arm_id] ?? 0) > (pBest[best.arm_id] ?? 0) ? a : best), recipes[0]!);
      const entry = tops.get(top.arm_id) ?? { segment_ids: [], p: 0 };
      entry.segment_ids.push(seg.segment_id);
      entry.p = Math.max(entry.p, pBest[top.arm_id] ?? 0);
      tops.set(top.arm_id, entry);
    }
    const arms = [...tops]
      .sort(([a, x], [b, y]) => y.p - x.p || a.localeCompare(b))
      .slice(0, MAX_GENERATION_ARMS)
      .map(([arm_id, { segment_ids }]) => ({ arm_id, segment_ids }));
    const segments = new Set(arms.flatMap((a) => a.segment_ids));
    const learning_ids = this.book
      .live()
      .filter((l) => segments.has(l.segment_id))
      .map((l) => l.learning_id);
    return { run_id: this.opts.run_id, round, arms, n_per_arm: 1, learning_ids };
  }

  // The round row's summary: B2's round summary plus calibration, the leaderboard, learnings
  // and the generation request.
  report(r: RoundReport) {
    const base = roundSummary(
      this.world,
      { run_id: this.opts.run_id, seed: this.opts.seed, population: this.opts.population, offsets: this.engine.offsets },
      r.days,
    );
    const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
    const roundImps = r.days.flatMap((d) => d.impressions);
    const control = this.engine.arms.find((a) => a.strategy === "control");
    return {
      ...base,
      calibration: {
        // Full precision: replaying p_cal from the stored offsets must reproduce it exactly.
        offsets: this.fit.offsets,
        // The warm-up probe's calls, on top of every round's own (D50).
        probe_jev: {
          calls: this.probe.calls,
          input_tokens: this.probe.input_tokens,
          cost_usd: round4((this.probe.input_tokens / 1e6) * config.jev.usdPerMillionInputTokens),
        },
        warm_up_fit: {
          n: this.fit.n,
          p_tap: round4(this.fit.p_tap),
          bounce_rate: round4(this.fit.bounce_rate),
          p_buy_given_stay: round4(this.fit.p_buy_given_stay),
          visit_to_purchase: round4(this.fit.visit_to_purchase),
          in_band: this.fit.in_band,
        },
      },
      leaderboard: this.world.segments.map((seg) => {
        const rows = r.armStats.filter((s) => s.segment_id === seg.segment_id);
        const segImps = roundImps.filter((i) => i.segment_id === seg.segment_id);
        const ranked = [...rows].sort((a, b) => b.post_mean - a.post_mean || a.arm_id.localeCompare(b.arm_id));
        const row = (s: ArmStat) => ({
          arm_id: s.arm_id,
          share_this_round: round4(segImps.length ? segImps.filter((i) => i.arm_id === s.arm_id).length / segImps.length : 0),
          impressions: s.impressions,
          p_best: round4(s.p_best),
          cpo_usd: s.est_cost_per_order_usd === null ? null : Math.round(s.est_cost_per_order_usd * 100) / 100,
          // The range: the cost per order at the posterior mean ± 2 sd.
          cpo_range_usd: [costPerOrder(s.post_mean + 2 * s.post_sd), costPerOrder(s.post_mean - 2 * s.post_sd)].map((x) =>
            x === null ? null : Math.round(x * 100) / 100,
          ),
        });
        return {
          segment_id: seg.segment_id,
          impressions_this_round: segImps.length,
          top: ranked.slice(0, 3).map(row),
          control: control ? row(rows.find((s) => s.arm_id === control.arm_id)!) : null,
        };
      }),
      learnings: {
        opened: r.opened.map(({ learning_id, kind, statement, directive }) => ({ learning_id, kind, statement, directive })),
        closed: r.closed.map((l) => l.learning_id),
        live: this.book.live().length,
      },
      generation: r.generation,
    };
  }
}

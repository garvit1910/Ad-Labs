import type { Arm } from "./contract.js";
import type { ArmPolicy, Impression } from "./engine.js";
import { keyedStream, normal, uniform, weightedIndex } from "./rng.js";

// "Reward, bandit and learnings" > "Bandit": Gaussian Thompson sampling per impression, with
// each (segment, arm) cell pooled toward the arm's mean across segments.
//
//   μ_{s,a} = (n0·m_a + Σr) / (n0 + n),   σ_{s,a} = sd_pool / √(n0 + n),   n0 = 30
//
// m_a is the arm's mean reward across all segments (an unseen arm uses the mean over all
// arms); sd_pool is the spread of r over every impression so far. Estimates refresh at the
// end of each sim day, so a day's picks never depend on processing order.

export const N0 = 30;
export const P_BEST_DRAWS = 2000;
export const FLOOR_CONTROL = 0.1;
export const FLOOR_OTHER = 0.03;

type Tally = { n: number; sum: number };
export type Posterior = { mean: number; sd: number; n: number; cellMean: number | null };

export class Bandit {
  private cells = new Map<string, Tally>();
  private armTotals = new Map<string, Tally>();
  // Welford's running mean and variance over every reward, for sd_pool.
  private count = 0;
  private mean = 0;
  private m2 = 0;
  // Per segment, refreshed at the end of each day: P(arm is best).
  private pBest = new Map<string, Record<string, number>>();
  readonly floors: Record<string, number>;
  // Σ floors: the share of impressions the floors hand out (0.40 with 10 recipes + control).
  readonly floorMass: number;

  constructor(
    readonly arms: readonly Arm[],
    readonly segmentIds: readonly string[],
    readonly seed: number,
  ) {
    this.floors = Object.fromEntries(arms.map((a) => [a.arm_id, a.strategy === "control" ? FLOOR_CONTROL : FLOOR_OTHER]));
    this.floorMass = Object.values(this.floors).reduce((s, f) => s + f, 0);
    if (this.floorMass > 1) throw new Error(`floors sum to ${this.floorMass} over ${arms.length} arms`);
  }

  get hasData(): boolean {
    return this.count > 0;
  }

  // End of a sim day: fold in the day's rewards, then refresh p_best.
  update(impressions: readonly Impression[], tick: number): void {
    for (const i of impressions) {
      const r = i.reward_cal;
      add(this.cells, `${i.segment_id}|${i.arm_id}`, r);
      add(this.armTotals, i.arm_id, r);
      this.count++;
      const d = r - this.mean;
      this.mean += d / this.count;
      this.m2 += d * (r - this.mean);
    }
    for (const s of this.segmentIds) this.pBest.set(s, this.estimatePBest(s, tick));
  }

  sdPool(): number {
    return this.count > 1 ? Math.sqrt(this.m2 / (this.count - 1)) : 0;
  }

  // m_a: the arm's mean across segments; an unseen arm uses the mean over all arms.
  armMean(armId: string): number {
    const t = this.armTotals.get(armId);
    return t && t.n > 0 ? t.sum / t.n : this.mean;
  }

  posterior(segmentId: string, armId: string): Posterior {
    const cell = this.cells.get(`${segmentId}|${armId}`) ?? { n: 0, sum: 0 };
    return {
      mean: (N0 * this.armMean(armId) + cell.sum) / (N0 + cell.n),
      sd: this.sdPool() / Math.sqrt(N0 + cell.n),
      n: cell.n,
      cellMean: cell.n > 0 ? cell.sum / cell.n : null,
    };
  }

  pBestFor(segmentId: string): Record<string, number> {
    return this.pBest.get(segmentId) ?? Object.fromEntries(this.arms.map((a) => [a.arm_id, 1 / this.arms.length]));
  }

  // Expected share of impressions per arm: its floor plus its part of the Thompson remainder.
  // p_best is the chance Thompson picks each arm (both come from the same posterior draws).
  sharesFor(segmentId: string): Record<string, number> {
    const q = this.pBestFor(segmentId);
    return Object.fromEntries(
      this.arms.map((a) => [a.arm_id, this.floors[a.arm_id]! + (1 - this.floorMass) * (q[a.arm_id] ?? 0)]),
    );
  }

  // p_best: the share of 2,000 joint posterior draws in which each arm is highest.
  private estimatePBest(segmentId: string, tick: number): Record<string, number> {
    const post = this.arms.map((a) => this.posterior(segmentId, a.arm_id));
    const wins = new Array<number>(this.arms.length).fill(0);
    const next = keyedStream(this.seed, "arm", "p_best", segmentId, tick);
    for (let d = 0; d < P_BEST_DRAWS; d++) {
      let best = 0;
      let bestTheta = -Infinity;
      for (let k = 0; k < post.length; k++) {
        const theta = post[k]!.mean + post[k]!.sd * gaussian(next);
        if (theta > bestTheta) {
          bestTheta = theta;
          best = k;
        }
      }
      wins[best]!++;
    }
    return Object.fromEntries(this.arms.map((a, k) => [a.arm_id, wins[k]! / P_BEST_DRAWS]));
  }

  // Per impression. The floors are a mixture, so they hold exactly whatever the posterior: with
  // probability Σ floors the impression goes to an arm drawn in proportion to its floor;
  // otherwise draw θ ~ N(μ, σ²) for every live arm and show the highest. So
  //   P(arm a) = floor_a + (1 − Σ floors) · P(Thompson picks a) ≥ floor_a.
  readonly policy: ArmPolicy = (shopper, arms, { seed, tick }) => {
    const id = shopper.shopper_id;
    if (!this.hasData) return arms[Math.floor(uniform(seed, "arm", id, tick) * arms.length)]!;
    const floors = arms.map((a) => this.floors[a.arm_id] ?? 0);
    if (uniform(seed, "arm", id, tick, "floor") < this.floorMass) {
      return arms[weightedIndex(floors, seed, "arm", id, tick, "floor_arm")]!;
    }
    let pick = arms[0]!;
    let bestTheta = -Infinity;
    for (const a of arms) {
      const p = this.posterior(shopper.segment_id, a.arm_id);
      const theta = normal(p.mean, p.sd, seed, "arm", id, tick, a.arm_id);
      if (theta > bestTheta) {
        bestTheta = theta;
        pick = a;
      }
    }
    return pick;
  };
}

function add(m: Map<string, Tally>, key: string, r: number): void {
  const t = m.get(key) ?? { n: 0, sum: 0 };
  t.n++;
  t.sum += r;
  m.set(key, t);
}

// Box-Muller over a fast stream.
function gaussian(next: () => number): number {
  const u1 = Math.max(next(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * next());
}

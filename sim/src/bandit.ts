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

// Shares that respect the floors, as close to `p` as possible: arms under their floor are
// raised to it and the rest are scaled down in proportion, repeated until nothing moves.
export function applyFloors(p: Record<string, number>, floors: Record<string, number>): Record<string, number> {
  const arms = Object.keys(p);
  const fixed = new Set<string>();
  for (;;) {
    const fixedMass = [...fixed].reduce((s, a) => s + floors[a]!, 0);
    const free = arms.filter((a) => !fixed.has(a));
    const freeP = free.reduce((s, a) => s + p[a]!, 0);
    const share = (a: string) =>
      fixed.has(a) ? floors[a]! : freeP > 0 ? ((1 - fixedMass) * p[a]!) / freeP : (1 - fixedMass) / free.length;
    const under = free.filter((a) => share(a) < floors[a]!);
    if (under.length === 0) return Object.fromEntries(arms.map((a) => [a, share(a)]));
    for (const a of under) fixed.add(a);
  }
}

export class Bandit {
  private cells = new Map<string, Tally>();
  private armTotals = new Map<string, Tally>();
  // Welford's running mean and variance over every reward, for sd_pool.
  private count = 0;
  private mean = 0;
  private m2 = 0;
  // Per segment, refreshed at the end of each day: P(arm is best), and the floored shares.
  private pBest = new Map<string, Record<string, number>>();
  private shares = new Map<string, Record<string, number>>();
  readonly floors: Record<string, number>;

  constructor(
    readonly arms: readonly Arm[],
    readonly segmentIds: readonly string[],
    readonly seed: number,
  ) {
    this.floors = Object.fromEntries(arms.map((a) => [a.arm_id, a.strategy === "control" ? FLOOR_CONTROL : FLOOR_OTHER]));
    const floorSum = Object.values(this.floors).reduce((s, f) => s + f, 0);
    if (floorSum > 1) throw new Error(`floors sum to ${floorSum} over ${arms.length} arms`);
  }

  get hasData(): boolean {
    return this.count > 0;
  }

  // End of a sim day: fold in the day's rewards, then refresh p_best and the shares.
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
    for (const s of this.segmentIds) {
      const pb = this.estimatePBest(s, tick);
      this.pBest.set(s, pb);
      this.shares.set(s, applyFloors(pb, this.floors));
    }
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

  sharesFor(segmentId: string): Record<string, number> {
    return this.shares.get(segmentId) ?? applyFloors(this.pBestFor(segmentId), this.floors);
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

  // Per impression: draw θ ~ N(μ, σ²) for every live arm and take the highest. The floors are
  // then met exactly: a pick from an arm above its floored share is kept with probability
  // share ÷ p_best, otherwise the impression goes to an arm below its floor, in proportion to
  // how far below it is. The result is shown with each arm's floored share.
  readonly policy: ArmPolicy = (shopper, arms, { seed, tick }) => {
    if (!this.hasData) return arms[Math.floor(uniform(seed, "arm", shopper.shopper_id, tick) * arms.length)]!;
    const segment = shopper.segment_id;
    let pick = arms[0]!;
    let bestTheta = -Infinity;
    for (const a of arms) {
      const p = this.posterior(segment, a.arm_id);
      const theta = normal(p.mean, p.sd, seed, "arm", shopper.shopper_id, tick, a.arm_id);
      if (theta > bestTheta) {
        bestTheta = theta;
        pick = a;
      }
    }
    const q = this.pBestFor(segment);
    const s = this.sharesFor(segment);
    const qa = q[pick.arm_id] ?? 0;
    const sa = s[pick.arm_id] ?? 0;
    if (qa <= sa || uniform(seed, "arm", shopper.shopper_id, tick, "keep") < sa / qa) return pick;
    const deficits = arms.map((a) => Math.max(0, (s[a.arm_id] ?? 0) - (q[a.arm_id] ?? 0)));
    if (!deficits.some((d) => d > 0)) return pick;
    return arms[weightedIndex(deficits, seed, "arm", shopper.shopper_id, tick, "floor")]!;
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

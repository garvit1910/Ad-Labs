/**
 * Beta belief curves over performance-memory cells (Workstream D). PURE.
 *
 * Replaces "one number per ingredient" with a posterior: number PLUS how sure.
 * Two scorecards per cell, both built from the DECAYED counts (Workstream C), so
 * evidence ages out of the curves automatically:
 *   - click layer:    Beta(priorα + decayedClicks,    priorβ + (decayedImpressions − decayedClicks))
 *   - purchase layer: Beta(priorα + decayedPurchases, priorβ + (decayedClicks − decayedPurchases))
 *
 * THE STALE-SYNC INVARIANT (lib/creative-engine/CLAUDE.md §Workstream C): at a
 * 14-day half-life, an org whose sync stalled shows near-zero decayed sums against
 * large raw totals. That cell's posterior collapses to its PRIOR — a wide,
 * low-confidence curve — and must never read as a confident zero rate. This module
 * guarantees it by construction: the prior floor keeps α,β ≥ 1 always, and evidence
 * enters only through the decayed counts.
 *
 * Priors are borrowed evidence, pooled from OTHER CONSENTING tenants' label cells
 * (the target org is excluded and non-participating donors are filtered out at the
 * fetcher; `PriorCellInput` carries no org id, so this pure layer structurally
 * cannot see whose data it is — only how many donors stand behind a cell, which is
 * what the `POOLED_MIN_DONOR_ORGS` k-floor needs). Fallback chain per dimension
 * value, run INDEPENDENTLY per layer (a value can clear the click pool floor and
 * miss the purchase one):
 *   pooled (this value cleared the floor) → dimension (dimension-wide average)
 *   → vague (Beta(1,1)).
 * A vague Beta(1,1) click prior has mean 0.5 — absurd as a CTR estimate, correct
 * as a Thompson prior: an unknown arm samples optimistically and gets explored
 * until a few hundred real impressions swamp it. Do NOT "fix" it to a confident
 * small rate; the optimism is the exploration mechanism.
 *
 * Decayed counts are FRACTIONAL (round4), so α/β are non-integer — fine for a
 * Beta. Purchases can exceed clicks (view-through conversions), so the purchase
 * layer clamps its failure count at 0 and its pooled rate at 1; a >1-per-click
 * cell truncates rather than producing a negative β.
 */

import { betaMoments } from '@/lib/agent/evals/statistics';
import { INDUSTRY_BENCH_MIN_MERCHANTS_DEFAULT } from '@/lib/industry/benchmarks';
import type {
  BeliefCurve,
  BeliefPriorSource,
  CellBeliefs,
  PriorCellInput,
} from './types';

/** Persisted shape version for `scores.beliefs` (bump on any field change). */
export const BELIEFS_VERSION = 1 as const;

/**
 * Click-layer prior strength: borrowed evidence worth ~500 impressions at the
 * pooled rate — strong enough that day-one picks aren't coin flips, weak enough
 * that days of real data outvote it.
 */
export const CLICK_PRIOR_ESS = 500;

/** Purchase-layer prior strength: borrowed evidence worth ~20 clicks. */
export const PURCHASE_PRIOR_ESS = 20;

/**
 * Added to BOTH prior counters on every rung (the vague rung is exactly
 * Beta(1,1)). Keeps α,β ≥ 1 always, so posteriors are proper even at zero
 * evidence and the sampler's α<1 path is belt-and-braces, not load-bearing.
 */
export const BELIEF_VAGUE_FLOOR = 1;

/**
 * A pooled (dimension, value) cell must carry at least this many decayed
 * impressions before it may seed a click prior — a 3-impression pooled cell
 * scaled to ESS 500 would launder noise into strong borrowed evidence.
 * Below-floor cells still contribute to the dimension-wide average rung.
 */
export const POOLED_MIN_DECAYED_IMPRESSIONS = 500;

/** Purchase-layer pool floor, in decayed clicks (mirrors PURCHASE_PRIOR_ESS). */
export const POOLED_MIN_DECAYED_CLICKS = 20;

/**
 * K-ANONYMITY: a pooled rung needs at least this many DISTINCT donor orgs behind
 * it. Below it, the borrowed rate is one (or two) merchants' real Meta
 * performance, which the borrowing org's members would then read back off
 * `scores.beliefs` — the volume floors above bound noise, not exposure.
 *
 * Pinned to the industry layer's merchant floor for parity (its density gate is
 * the product gate). Deliberately the DEFAULT constant, not the env-resolved
 * value: `INDUSTRY_BENCH_MIN_MERCHANTS` tunes what a benchmark PAGE will show,
 * and must not be able to lower a privacy floor from an env var.
 */
export const POOLED_MIN_DONOR_ORGS = INDUSTRY_BENCH_MIN_MERCHANTS_DEFAULT;

interface PoolSums {
  impressions: number;
  clicks: number;
  purchases: number;
  /** Distinct donor orgs, for the k-floor. See `deriveBeliefPriors` for the dimension bound. */
  donors: number;
}

/** Pooled decayed sums, per (dimension, value) and per dimension. Internal. */
export interface BeliefPriorTable {
  valueSums: Map<string, PoolSums>;
  dimensionSums: Map<string, PoolSums>;
}

interface LayerPrior {
  alpha: number;
  beta: number;
  source: BeliefPriorSource;
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

const valueKey = (dimension: string, dimensionValue: string): string =>
  `${dimension}\0${dimensionValue}`;

function addTo(map: Map<string, PoolSums>, key: string, cell: PriorCellInput): void {
  const sums = map.get(key) ?? { impressions: 0, clicks: 0, purchases: 0, donors: 0 };
  sums.impressions += Math.max(0, cell.decayedImpressions);
  sums.clicks += Math.max(0, cell.decayedClicks);
  sums.purchases += Math.max(0, cell.decayedPurchases);
  sums.donors += Math.max(0, cell.donorCount);
  map.set(key, sums);
}

/**
 * Fold pooled cross-tenant cells into the prior lookup table. Pure aggregation —
 * an empty input (pool fetch failed, or no other tenants have data) yields a
 * table where every lookup falls through to the vague rung, which is the safe
 * failure direction for a sampler: LOW CONFIDENCE, never a confident wrong rate.
 *
 * The DIMENSION rung's donor count is the MAX per-value count, not the sum: one
 * donor contributes a row to many values of the same dimension, so summing would
 * let a single merchant clear the k-floor on its own. Every donor behind the
 * best-covered value is a distinct donor of the dimension, so the max is a sound
 * LOWER BOUND — it can only under-count, which drops the rung to vague.
 */
export function deriveBeliefPriors(cells: PriorCellInput[]): BeliefPriorTable {
  const valueSums = new Map<string, PoolSums>();
  const dimensionOfKey = new Map<string, string>();
  for (const cell of cells) {
    const key = valueKey(cell.dimension, cell.dimensionValue);
    dimensionOfKey.set(key, cell.dimension);
    addTo(valueSums, key, cell);
  }

  const dimensionSums = new Map<string, PoolSums>();
  for (const [key, sums] of valueSums) {
    const dimension = dimensionOfKey.get(key)!;
    const dim = dimensionSums.get(dimension) ?? {
      impressions: 0,
      clicks: 0,
      purchases: 0,
      donors: 0,
    };
    dim.impressions += sums.impressions;
    dim.clicks += sums.clicks;
    dim.purchases += sums.purchases;
    dim.donors = Math.max(dim.donors, sums.donors);
    dimensionSums.set(dimension, dim);
  }
  return { valueSums, dimensionSums };
}

/** Scale a pooled rate to the layer's ESS, with the vague floor on both counters. */
function scaledPrior(rate: number, ess: number, source: BeliefPriorSource): LayerPrior {
  const clamped = Math.min(1, Math.max(0, rate));
  return {
    alpha: clamped * ess + BELIEF_VAGUE_FLOOR,
    beta: (1 - clamped) * ess + BELIEF_VAGUE_FLOOR,
    source,
  };
}

const VAGUE_PRIOR: LayerPrior = {
  alpha: BELIEF_VAGUE_FLOOR,
  beta: BELIEF_VAGUE_FLOOR,
  source: 'vague',
};

/** Both floors, in one place: enough volume to be signal, enough donors to be anonymous. */
const clearsClickFloors = (sums: PoolSums): boolean =>
  sums.impressions >= POOLED_MIN_DECAYED_IMPRESSIONS && sums.donors >= POOLED_MIN_DONOR_ORGS;

const clearsPurchaseFloors = (sums: PoolSums): boolean =>
  sums.clicks >= POOLED_MIN_DECAYED_CLICKS && sums.donors >= POOLED_MIN_DONOR_ORGS;

function clickPriorFor(table: BeliefPriorTable, dimension: string, value: string): LayerPrior {
  const cell = table.valueSums.get(valueKey(dimension, value));
  if (cell && clearsClickFloors(cell)) {
    return scaledPrior(cell.clicks / cell.impressions, CLICK_PRIOR_ESS, 'pooled');
  }
  const dim = table.dimensionSums.get(dimension);
  if (dim && clearsClickFloors(dim)) {
    return scaledPrior(dim.clicks / dim.impressions, CLICK_PRIOR_ESS, 'dimension');
  }
  return VAGUE_PRIOR;
}

function purchasePriorFor(table: BeliefPriorTable, dimension: string, value: string): LayerPrior {
  const cell = table.valueSums.get(valueKey(dimension, value));
  if (cell && clearsPurchaseFloors(cell)) {
    return scaledPrior(cell.purchases / cell.clicks, PURCHASE_PRIOR_ESS, 'pooled');
  }
  const dim = table.dimensionSums.get(dimension);
  if (dim && clearsPurchaseFloors(dim)) {
    return scaledPrior(dim.purchases / dim.clicks, PURCHASE_PRIOR_ESS, 'dimension');
  }
  return VAGUE_PRIOR;
}

/** The slice of a rollup/read row the belief builder needs. Structural on purpose. */
export interface CellBeliefInput {
  dimension: string;
  dimensionValue: string;
  decayedImpressions: number;
  decayedClicks: number;
  decayedPurchases: number;
}

function toCurve(prior: LayerPrior, successes: number, failures: number): BeliefCurve {
  const alpha = round4(prior.alpha + Math.max(0, successes));
  const beta = round4(prior.beta + Math.max(0, failures));
  const moments = betaMoments(alpha, beta);
  return {
    alpha,
    beta,
    mean: round4(moments.mean),
    ci95: [round4(moments.ci95[0]), round4(moments.ci95[1])],
    source: prior.source,
    priorEss: round4(prior.alpha + prior.beta),
  };
}

/**
 * Build the two belief curves for one cell from its decayed counts + the pooled
 * prior table. Deterministic — same inputs, byte-identical output; no clock, no
 * randomness (sampling happens in `sampler.ts`, never here).
 */
export function buildCellBeliefs(cell: CellBeliefInput, table: BeliefPriorTable): CellBeliefs {
  const clickPrior = clickPriorFor(table, cell.dimension, cell.dimensionValue);
  const purchasePrior = purchasePriorFor(table, cell.dimension, cell.dimensionValue);
  return {
    v: BELIEFS_VERSION,
    basis: 'platform',
    click: toCurve(
      clickPrior,
      cell.decayedClicks,
      cell.decayedImpressions - cell.decayedClicks
    ),
    purchase: toCurve(
      purchasePrior,
      cell.decayedPurchases,
      cell.decayedClicks - cell.decayedPurchases
    ),
  };
}

// ── Comparing two curves (Workstream H) ──────────────────────────────────────

/**
 * How much of a curve is EVIDENCE rather than borrowed prior: α+β minus the
 * prior that seeded it. A vague-prior cell with no traffic scores 0 here, which
 * is exactly the honest answer.
 */
export function beliefEvidenceEss(curve: BeliefCurve): number {
  return Math.max(0, round4(curve.alpha + curve.beta - curve.priorEss));
}

/**
 * Evidence floors a curve must clear before its INTERVAL BOUNDS may drive
 * anything. Pinned to D's own pool floors rather than re-derived — the click
 * layer is the repo's settled 500, the purchase layer its 20-click twin.
 *
 * The floors are not decoration. `betaMoments` documents that its normal
 * approximation is "conservative-wide, symmetric" and that only the WIDTH
 * ORDERING is safe to rely on for tiny or heavily skewed curves. Anything that
 * leans on the bounds themselves must therefore refuse to look at a thin curve,
 * and that refusal is what these constants are.
 */
export const BELIEF_DECISION_MIN_CLICK_ESS = POOLED_MIN_DECAYED_IMPRESSIONS;
/** Purchase-layer twin of `BELIEF_DECISION_MIN_CLICK_ESS`, in decayed clicks. */
export const BELIEF_DECISION_MIN_PURCHASE_ESS = POOLED_MIN_DECAYED_CLICKS;

/**
 * One layer's containment test, with its evidence floor applied to BOTH sides.
 * Exported so a consumer reasoning about a SINGLE layer (the report card's
 * belief moves) uses this predicate directly rather than faking a two-layer
 * `CellBeliefs` to get at it.
 */
export function beliefCurveCredibleShift(
  next: BeliefCurve,
  previous: BeliefCurve,
  minEvidenceEss: number
): boolean {
  if (beliefEvidenceEss(next) < minEvidenceEss) return false;
  if (beliefEvidenceEss(previous) < minEvidenceEss) return false;
  return previous.mean < next.ci95[0] || previous.mean > next.ci95[1];
}

/**
 * ONE-SIDED sibling of `beliefCurveCredibleShift`: is `value` credibly ABOVE
 * `reference`, rather than merely credibly DIFFERENT from it? True only when
 * both curves clear `minEvidenceEss` of real (non-borrowed) evidence AND the
 * WHOLE of `value`'s 95% band sits above the whole of `reference`'s.
 *
 * Band-above-band, not mean-outside-band, and that asymmetry is the point: this
 * predicate is read as a claim about direction ("this value beat its peers"),
 * so it must refuse whenever the two intervals could still be telling the same
 * story. The evidence floors are the same refusal `betaMoments`' wide normal
 * approximation forces on anything that leans on the BOUNDS (see
 * `BELIEF_DECISION_MIN_CLICK_ESS`) — a thin curve cannot win a comparison.
 *
 * SANCTIONED CONSUMER: the lesson-emission peer gate in
 * `loop/fact-candidates.ts` ("is this value credibly above its peers before we
 * write it into the brand's notebook?"). That is a NOTEBOOK FLOOR, not an
 * inference verdict — a kill, a crown and a winner are still
 * `proportionCIsOverlap`'s alone (lib/agent/evals/statistics.ts), which remains
 * the ONE significance mechanism in this codebase. Do not reach for this
 * function to decide any of those three.
 */
export function beliefCurveCrediblyAbove(
  value: BeliefCurve,
  reference: BeliefCurve,
  minEvidenceEss: number
): boolean {
  if (beliefEvidenceEss(value) < minEvidenceEss) return false;
  if (beliefEvidenceEss(reference) < minEvidenceEss) return false;
  return value.ci95[0] > reference.ci95[1];
}

/**
 * Has the belief moved enough that the old claim is no longer credible?
 * True when the NEW interval no longer contains the OLD centre, on either
 * layer, with both sides above their evidence floor.
 *
 * THIS IS A MATERIALITY HEURISTIC, NOT AN INFERENCE CLAIM. It answers "should
 * we rewrite the lesson?", never "is A better than B" — `proportionCIsOverlap`
 * (lib/agent/evals/statistics.ts) remains the ONE significance mechanism in this
 * codebase, and nothing here competes with it. Do not reach for this function to
 * decide a kill, a crown, or a winner.
 *
 * ONE further consumer of this family is sanctioned, and only one: the
 * lesson-emission peer gate in `loop/fact-candidates.ts` reads the one-sided
 * `beliefCurveCrediblyAbove` above to ask "is this value credibly above its
 * peers before we write it down?". That is a NOTEBOOK FLOOR on what the engine
 * is allowed to claim it learned — still not a kill, a crown or a winner, which
 * remain `proportionCIsOverlap`'s decisions.
 *
 * EITHER SIDE MISSING ⇒ FALSE, and that is load-bearing. On the first sweep
 * after this shipped, no live fact carried a belief snapshot; reading "no
 * history" as "credibly different" would have superseded every lesson in the
 * corpus at once — precisely the churn the materiality gate exists to prevent.
 * The other materiality arms still get their say.
 */
export function beliefsCredibleShift(
  next: CellBeliefs | null | undefined,
  previous: CellBeliefs | null | undefined
): boolean {
  if (!next || !previous) return false;
  return (
    beliefCurveCredibleShift(next.click, previous.click, BELIEF_DECISION_MIN_CLICK_ESS) ||
    beliefCurveCredibleShift(
      next.purchase,
      previous.purchase,
      BELIEF_DECISION_MIN_PURCHASE_ESS
    )
  );
}

/**
 * THE OBJECTIVE LAYER (Workstream G, step 6 of the 19-step program). PURE.
 *
 * Until this module the loop optimized ONE thing: click-through. The sampler
 * ranked arms on the click posterior, the kill rule compared CTR, and only the
 * lesson floors ever looked at ROAS. Production accounts are judged on cost per
 * click, ROAS, contribution margin and target CPA — so the org picks a ruler
 * (`organizations.settings.creativeFence.objective`) and the sampler, the kill
 * rule and the lesson peer gate all read THAT ruler.
 *
 * FOUR OBJECTIVES, THREE RULERS:
 *
 * | objective | ranked on                                   |
 * |-----------|---------------------------------------------|
 * | `ctr`     | clicks per impression (the click posterior) |
 * | `cpc`     | clicks per impression — AN ALIAS OF `ctr`   |
 * | `cpa`     | purchases per impression                    |
 * | `roas`    | purchase VALUE per impression               |
 *
 * **`cpc` is deliberately an alias of `ctr`, and this is not a stub.** Cost per
 * click is `CPM / (1000 × CTR)`: at a fixed CPM, ranking ads by ascending CPC
 * and by descending CTR is the SAME ordering. The loop observes no per-cell
 * CPM — `performance_memory` carries `decayedSpend` per (dimension, value), but
 * spend is an allocator artifact (the platform decides which ad gets volume),
 * not a property of the angle/hook/format cell, so a per-cell CPM read from it
 * would be measuring the allocator, not the creative. Faking a cost model to
 * make `cpc` look distinct would be inventing structure the data cannot
 * support, so `cpc` ranks exactly as `ctr` does and says so — here, in
 * `lib/creative-engine/CLAUDE.md`, and in every sampler stamp (the stamp still
 * records `objective: 'cpc'`, so the org's CHOICE stays auditable even though
 * the ranking is identical).
 *
 * THE POSTERIOR FOR `roas` — a value-weighted Beta draw, NOT a new distribution.
 * Purchase VALUE per impression is not a rate in [0, 1], so no Beta describes it
 * directly. This module factorizes it into the part the data can measure and the
 * part it cannot:
 *
 *     value per impression = (purchases per impression) × (value per purchase)
 *                            └── Beta posterior ──────┘   └── plug-in AOV ───┘
 *
 * The COUNT factor carries all the uncertainty and gets the same Beta the click
 * layer uses — `Beta(1 + decayedPurchases, 1 + (decayedImpressions −
 * decayedPurchases))` — so one raffle ticket per arm is still ONE `sampleBeta`
 * in arm order and the sampler's determinism contract is untouched. The VALUE
 * factor is the cell's own realized average order value
 * (`decayedPurchaseValue / decayedPurchases`), applied as a deterministic
 * multiplier to the draw, the mean and both interval bounds.
 *
 * Why a Beta on purchases-per-impression rather than the Gamma–Poisson the
 * count model would suggest: at these rates (purchases per impression run
 * 1e-4–1e-3) `Beta(1+k, 1+n−k)` and `Gamma(1+k, n)` agree to several decimal
 * places, and the Beta reuses the repo's ONE sampling primitive
 * (`sampleBeta`) — a second sampler would be a second thing to keep
 * deterministic, for no measurable difference.
 *
 * ITS VARIANCE LIMITS, stated plainly because a plug-in always has some:
 *  - AOV enters WITHOUT an interval. A cell whose orders are $20 and $2,000 is
 *    reported as confidently as one whose orders are all $200; the draw's spread
 *    reflects only how sure we are of the COUNT.
 *  - A single unusually large order shifts an arm's whole value scale by its
 *    full amount, and nothing widens in response. The purchase floor below is
 *    what bounds that: at the floor, one order is at most a tenth of the scale.
 *  - The Beta treats purchases as independent per impression. Basket
 *    correlation, repeat buyers and delayed conversions all violate that; the
 *    effect is an interval that is somewhat too NARROW, which is the direction
 *    the floors exist to absorb.
 *  - `decayedPurchaseValue` is the PLATFORM's value on the platform basis (see
 *    `loop/basis.ts`); this layer never promotes a cell to the verified ruler.
 *
 * SPARSITY. Purchases are rare. Every consumer of this module therefore has a
 * documented floor below which the objective layer REFUSES and the caller falls
 * back to the click layer, and every fallback is STAMPED (sampler records,
 * kill assessments, peer evidence) — never silent.
 */

import { betaMoments } from '@/lib/agent/evals/statistics';
import type { BeliefCurve, CreativeObjective } from './types';

/** Every objective the fence setting accepts, in one place. */
export const CREATIVE_OBJECTIVES: readonly CreativeObjective[] = [
  'ctr',
  'cpc',
  'roas',
  'cpa',
] as const;

/**
 * The ruler an org gets when it has never chosen one — and the ruler every
 * number recorded before this layer existed was measured on.
 */
export const DEFAULT_CREATIVE_OBJECTIVE: CreativeObjective = 'ctr';

export function isCreativeObjective(value: unknown): value is CreativeObjective {
  return typeof value === 'string' && (CREATIVE_OBJECTIVES as readonly string[]).includes(value);
}

/**
 * Stored settings → an objective. Anything unrecognized (absent, null, a typo,
 * a value from a future version) degrades to the DEFAULT — the pre-objective
 * behaviour — which is the only safe direction for a knob that redirects what
 * the engine optimizes.
 */
export function resolveCreativeObjective(value: unknown): CreativeObjective {
  return isCreativeObjective(value) ? value : DEFAULT_CREATIVE_OBJECTIVE;
}

/**
 * True for `ctr` and `cpc`: the click layer IS the ruler, and every consumer
 * takes its pre-objective code path unchanged. This is the predicate that makes
 * "setting absent = byte-identical" a structural fact rather than a promise.
 */
export function objectiveRanksOnClicks(objective: CreativeObjective): boolean {
  return objective === 'ctr' || objective === 'cpc';
}

/**
 * The decayed counts the objective layer reads out of one cell. A structural
 * subset of `DimensionRollup` / `PerformanceMemoryReadRow`, so a caller passes
 * a row and nothing has to be re-shaped. DECAYED, never raw: the objective
 * ruler must forget at the same rate the click ruler does, or an org would
 * optimize value against ancient history while pruning clicks on fresh data.
 */
export interface ObjectiveEvidence {
  decayedImpressions: number;
  decayedClicks: number;
  decayedPurchases: number;
  decayedPurchaseValue: number;
}

/**
 * The impression floor for an objective-layer claim: the repo's settled 500
 * (`POOLED_MIN_DECAYED_IMPRESSIONS`, the refresh comparator, the fatigue
 * halves, the lifecycle thresholds). Pinned to that constant's VALUE rather
 * than imported from `posterior.ts` so this module stays a leaf.
 */
export const OBJECTIVE_MIN_DECAYED_IMPRESSIONS = 500;

/**
 * The purchase floor for a SAMPLER claim: three decayed purchase events.
 *
 * Below three, the posterior is dominated by whether one event happened, and —
 * worse for `roas` — the plug-in AOV would be a single order's price quoted as
 * the cell's value scale. Three is the smallest count at which an arm can lose
 * one event and still have evidence on both sides of it. It is deliberately
 * LOWER than the kill rule's floor: proposing the wrong ad is recoverable
 * (the next brief re-raffles), pausing a live ad is not.
 */
export const OBJECTIVE_MIN_DECAYED_PURCHASES = 3;

/**
 * The purchase floor for a KILL, per side: ten purchase events.
 *
 * Derived, not chosen. The kill rule fires only when one side's whole interval
 * sits below `effectiveMargin ×` the other's bound, and the TIGHTEST margin the
 * relaxation can ever reach is `killMarginRatioMax` (0.90 shipped) — a 10%
 * deficit. One purchase moves an observed rate by `1/k`. Requiring `1/k ≤ 0.10`
 * ⇒ `k ≥ 10` is exactly the statement "no single purchase, lucky or unlucky,
 * can by itself manufacture the deficit the rule needs to fire". Raising
 * `killMarginRatioMax` toward 1.0 would require raising this in step, which is
 * why the derivation is written down rather than the number alone.
 */
export const OBJECTIVE_KILL_MIN_PURCHASES_PER_SIDE = 10;

const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Read an objective-evidence slice off any row that structurally carries one. */
export function objectiveEvidenceOf(row: {
  decayedImpressions?: number;
  decayedClicks?: number;
  decayedPurchases?: number;
  decayedPurchaseValue?: number;
}): ObjectiveEvidence | null {
  if (
    typeof row.decayedImpressions !== 'number' ||
    typeof row.decayedClicks !== 'number' ||
    typeof row.decayedPurchases !== 'number' ||
    typeof row.decayedPurchaseValue !== 'number'
  ) {
    return null;
  }
  return {
    decayedImpressions: finite(row.decayedImpressions),
    decayedClicks: finite(row.decayedClicks),
    decayedPurchases: finite(row.decayedPurchases),
    decayedPurchaseValue: finite(row.decayedPurchaseValue),
  };
}

/**
 * Does this cell carry enough objective-layer evidence to be RANKED on it?
 * Both floors, or the caller falls back to the click layer and stamps it.
 */
export function hasObjectiveEvidence(
  evidence: ObjectiveEvidence | null | undefined,
  minPurchases: number = OBJECTIVE_MIN_DECAYED_PURCHASES
): evidence is ObjectiveEvidence {
  if (!evidence) return false;
  return (
    evidence.decayedImpressions >= OBJECTIVE_MIN_DECAYED_IMPRESSIONS &&
    evidence.decayedPurchases >= minPurchases
  );
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

/**
 * The COUNT factor's posterior: purchases per impression, `Beta(1 + purchases,
 * 1 + (impressions − purchases))`.
 *
 * A VAGUE Beta(1,1) prior, deliberately, where the click layer borrows pooled
 * cross-tenant evidence. The pooled purchase rung in `posterior.ts` is
 * purchases per CLICK — a different denominator, so it cannot seed this curve —
 * and no pooled purchases-per-impression table exists. The vague prior is also
 * not the absurdity it is on the click layer: `β` grows with every impression,
 * so a cell with no purchases and real volume reads as a small rate with a wide
 * band, not as the click layer's mean-0.5 optimism.
 *
 * Purchases may exceed impressions in pathological data (view-through
 * attribution against a thin impression count); the failure count clamps at 0
 * rather than producing a negative `β`, exactly as the purchase layer does.
 */
export function objectivePurchaseCurve(evidence: ObjectiveEvidence): BeliefCurve {
  const successes = Math.max(0, evidence.decayedPurchases);
  const failures = Math.max(0, evidence.decayedImpressions - successes);
  const alpha = round4(1 + successes);
  const beta = round4(1 + failures);
  const moments = betaMoments(alpha, beta);
  return {
    alpha,
    beta,
    mean: round4(moments.mean),
    ci95: [round4(moments.ci95[0]), round4(moments.ci95[1])],
    source: 'vague',
    priorEss: 2,
  };
}

/**
 * The VALUE factor: what one purchase is worth, in the objective's units.
 * `roas` → the cell's realized average order value; `cpa` → 1, because a
 * purchase IS the unit. See the variance limits in the module docblock: this is
 * a point estimate, and nothing about it widens.
 */
export function objectiveValueScale(
  objective: CreativeObjective,
  evidence: ObjectiveEvidence
): number {
  if (objective !== 'roas') return 1;
  if (!(evidence.decayedPurchases > 0)) return 0;
  return evidence.decayedPurchaseValue / evidence.decayedPurchases;
}

/**
 * What a CLICK is worth in the objective's units, pooled over a whole arm set —
 * the price the fallback path puts on an arm that has clicks but not enough
 * purchases to be ranked on its own.
 *
 * Why it exists: an arm below the purchase floor has to be ranked SOMEHOW, and
 * ranking it on its raw click curve would put a number near 0.02 (a CTR) beside
 * numbers near 0.0002 (a value per impression) — the below-floor arm would win
 * every raffle forever, purely on units. Multiplying its click draw by the arm
 * set's own realized value-per-click puts both on the same scale using only
 * evidence the set already holds: no new data source, no invented structure,
 * and the Thompson optimism of the wide click curve survives intact.
 *
 * Returns 0 when the pool has no clicks at all. A caller MUST treat a
 * non-positive scale as "this ruler cannot price the arms it cannot measure"
 * and fall the whole decision back to the click layer — otherwise every
 * below-floor arm would draw exactly 0 and exploration would starve silently.
 */
export function objectivePoolScale(
  objective: CreativeObjective,
  evidences: readonly ObjectiveEvidence[]
): number {
  let clicks = 0;
  let purchases = 0;
  let value = 0;
  for (const evidence of evidences) {
    clicks += Math.max(0, evidence.decayedClicks);
    purchases += Math.max(0, evidence.decayedPurchases);
    value += Math.max(0, evidence.decayedPurchaseValue);
  }
  if (!(clicks > 0)) return 0;
  return (objective === 'roas' ? value : purchases) / clicks;
}

/** A curve scaled into the objective's units — the shape every ranker consumes. */
export interface ScaledCurve {
  curve: BeliefCurve;
  /** The multiplier already applied to `mean`/`ci95` below (and to be applied to a draw). */
  scale: number;
  mean: number;
  ci95: [number, number];
  /** True when `curve` is the CLICK curve priced at the pool scale, not this cell's own. */
  fallback: boolean;
}

/** Apply a value scale to a curve's summary statistics. Pure arithmetic. */
export function scaleCurve(curve: BeliefCurve, scale: number, fallback: boolean): ScaledCurve {
  return {
    curve,
    scale,
    mean: curve.mean * scale,
    ci95: [curve.ci95[0] * scale, curve.ci95[1] * scale],
    fallback,
  };
}

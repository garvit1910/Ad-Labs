/**
 * Thompson sampling over belief curves (Workstream D). PURE.
 *
 * The picker Workstream E swaps into the greedy strategy selector: each arm hands
 * over one raffle ticket drawn from its own belief curve; the highest ticket wins.
 * Proven winners (narrow high curves) win almost always — exploitation. Uncertain
 * arms (wide curves) occasionally draw spectacular tickets — exploration,
 * automatically proportional to uncertainty, winding down as curves narrow. No
 * hand-tuned explore rate, no schedule.
 *
 * Determinism contract: ALL randomness is the injected `rng` — one uniform stream,
 * consumed one `sampleBeta` per arm in ARM ORDER. `armsFromBeliefs` sorts arms by
 * value (code-unit order) precisely so the rng consumption order — and therefore
 * the whole decision — is a pure function of (arms, layer, seed), independent of
 * input row order. Same seed ⇒ byte-identical `SamplerDecision`, forever
 * (auditable dice). Use `makeRng(seed)`; `Math.random` is banned here and in
 * every consumer.
 *
 * THE OBJECTIVE (step 6): `thompsonPick`/`widestCurvePick` take an optional
 * `objective` (`loop/objective.ts`). `ctr` — the default — and its `cpc` alias
 * rank on the click curve, taking the pre-objective code path verbatim. `cpa`
 * and `roas` rank on a purchases-per-impression Beta derived from the row's
 * DECAYED counts, `roas` scaled by the cell's realized value per purchase. An
 * arm below the objective floors is priced off its click curve at the arm set's
 * pooled value-per-click and stamped `objectiveFallback`; if no arm clears the
 * floors (or the set has no clicks to price the ones that do not) the whole
 * decision falls back to the click layer, also stamped. The rng contract holds
 * on every path: one `sampleBeta` per arm, in arm order.
 *
 * `'other'` is a legal ACCOUNTING bucket in every closed dimension but must never
 * be a PICKABLE ARM (`deterministicAngleDirective('other')` renders nonsense —
 * lib/creative-engine/CLAUDE.md §Workstream B assigned the exclusion to the
 * picker). `armsFromBeliefs` drops it unconditionally, even when a caller's
 * `allowedValues` lists it — consumers must build arms through this function,
 * never by hand.
 */

import { mulberry32, sampleBeta } from '@/lib/agent/evals/statistics';
import {
  DEFAULT_CREATIVE_OBJECTIVE,
  hasObjectiveEvidence,
  objectiveEvidenceOf,
  objectivePoolScale,
  objectivePurchaseCurve,
  objectiveRanksOnClicks,
  objectiveValueScale,
  scaleCurve,
  type ObjectiveEvidence,
  type ScaledCurve,
} from './objective';
import type { BeliefCurve, CellBeliefs, CreativeObjective } from './types';

/** The one dimension value that is never a pickable arm. */
export const UNPICKABLE_VALUE = 'other';

export type BeliefLayer = 'click' | 'purchase';

/** One pickable option: a (dimension, value) with its belief curves. */
export interface Arm {
  dimension: string;
  value: string;
  beliefs: CellBeliefs;
  /**
   * The row's decayed counts, when it carried them — the OBJECTIVE layer's
   * evidence (`loop/objective.ts`). Absent on rows that do not (the arena's
   * belief-only projection, hand-built test fixtures), which is exactly the
   * "cannot rank on this ruler" case the fallback below handles.
   */
  evidence?: ObjectiveEvidence;
}

/** Per-arm audit record inside a decision. `draw` is absent on widest-curve picks. */
export interface SamplerArmRecord {
  value: string;
  /** The Thompson raffle ticket sampled from this arm's curve. */
  draw?: number;
  /** Posterior mean at decision time. */
  mean: number;
  /** Credible interval at decision time. */
  ci95: [number, number];
  /**
   * PRESENT (and always `true`) when this arm had too little objective-layer
   * evidence of its own and was priced off its CLICK curve at the arm set's
   * pooled value-per-click instead. Absent on the default `ctr`/`cpc` ruler and
   * on any arm that cleared the floor — so the fallback is visible in every
   * shadow report and never silent.
   */
  objectiveFallback?: true;
}

/**
 * The full record of one pick — simultaneously the audit trail, the replay
 * mechanism (re-run with the same seed), and the dataset that later grades the
 * picker itself. Workstream E persists it; this module only returns it.
 */
export interface SamplerDecision {
  strategy: 'thompson' | 'widest';
  /**
   * The BELIEF layer whose persisted curves were read. Under `roas`/`cpa` the
   * objective curve is derived fresh from the row's decayed counts and is not a
   * persisted layer, so this field keeps naming the layer the FALLBACK path
   * uses; `objective` below names the ruler actually applied.
   */
  layer: BeliefLayer;
  picked: { dimension: string; value: string };
  /**
   * 'exploit' when the picked arm holds the highest posterior mean; 'explore'
   * when a lower-mean arm won the raffle (or was deliberately chosen for width).
   */
  mode: 'exploit' | 'explore';
  arms: SamplerArmRecord[];
  /** The ruler applied. ABSENT under the default `ctr` (byte-identical stamps). */
  objective?: CreativeObjective;
  /**
   * Present when the WHOLE decision fell back to `layer` rather than this or
   * that arm: `no_arm_evidence` = not one arm cleared the objective floors;
   * `no_pool_scale` = arms cleared the floors but the set has no clicks to
   * price the ones that did not, so the ruler could not put every arm on one
   * scale. Both are honest refusals, both stamped.
   *
   * When this is set, NO arm carries a per-arm `objectiveFallback`: that flag
   * marks a MIXED decision, and stamping every arm would make "some arms fell
   * back" and "the whole ruler stood down" indistinguishable in a report.
   */
  objectiveFallback?: 'no_arm_evidence' | 'no_pool_scale';
}

/**
 * Seeded randomness for the raffle. Record the seed with the decision and any
 * past pick replays exactly. Thin wrapper so consumers never import a PRNG
 * themselves (and never reach for `Math.random`).
 */
export function makeRng(seed: number): () => number {
  return mulberry32(seed);
}

/** The row slice `armsFromBeliefs` consumes — matches `PerformanceMemoryReadRow`. */
export interface ArmsFromBeliefsRow {
  dimension: string;
  dimensionValue: string;
  beliefs: CellBeliefs | null;
  /**
   * The decayed counts, OPTIONAL so every existing caller (and every existing
   * fixture) still type-checks unchanged. When all four are present the arm
   * carries objective-layer evidence; when any is missing the arm can only ever
   * be ranked on the click layer, and a `roas`/`cpa` pick records the fallback.
   * `PerformanceMemoryReadRow` satisfies all four, which is why the objective
   * layer needs NO change to the persisted `scores.beliefs` shape.
   */
  decayedImpressions?: number;
  decayedClicks?: number;
  decayedPurchases?: number;
  decayedPurchaseValue?: number;
}

export interface ArmsOptions {
  /**
   * Optional producibility restriction (Workstream E passes the producible
   * subset). Intersected with the rows; `'other'` is excluded regardless.
   */
  allowedValues?: readonly string[];
}

/**
 * Build the arm set for one dimension from belief-carrying rows. Drops
 * `'other'` unconditionally, drops rows without beliefs (pre-D rows read as
 * `beliefs: null`), applies `allowedValues`, dedupes values that appear on
 * multiple rows (meta+tiktok, genome+label) by keeping the row with the larger
 * click-curve ESS (α+β) — strictly-greater replaces, ties keep the first
 * encountered. That max-ESS dedupe is a v1 rule (not a true re-pool of the
 * underlying counts); Workstream E may replace it with a real merge. Output is
 * sorted by value in code-unit order — see the determinism contract above.
 */
export function armsFromBeliefs(
  rows: ArmsFromBeliefsRow[],
  dimension: string,
  options: ArmsOptions = {}
): Arm[] {
  const allowed = options.allowedValues ? new Set(options.allowedValues) : null;
  const byValue = new Map<string, Arm>();
  for (const row of rows) {
    if (row.dimension !== dimension) continue;
    if (row.beliefs === null) continue;
    const value = row.dimensionValue;
    if (value === UNPICKABLE_VALUE) continue;
    if (allowed && !allowed.has(value)) continue;
    const evidence = objectiveEvidenceOf(row);
    const candidate: Arm = {
      dimension,
      value,
      beliefs: row.beliefs,
      ...(evidence ? { evidence } : {}),
    };
    const existing = byValue.get(value);
    if (!existing) {
      byValue.set(value, candidate);
      continue;
    }
    const candidateEss = candidate.beliefs.click.alpha + candidate.beliefs.click.beta;
    const existingEss = existing.beliefs.click.alpha + existing.beliefs.click.beta;
    if (candidateEss > existingEss) byValue.set(value, candidate);
  }
  return [...byValue.values()].sort((a, b) =>
    a.value < b.value ? -1 : a.value > b.value ? 1 : 0
  );
}

const curveFor = (arm: Arm, layer: BeliefLayer): BeliefCurve => arm.beliefs[layer];

/**
 * THE RULER for one pick: which curve each arm is ranked on, and at what scale.
 *
 * Under `ctr`/`cpc` this returns null and both pick functions take their
 * pre-objective path VERBATIM — same curve, same `sampleBeta(α, β)` arguments,
 * same records. That is why "the setting is absent" is byte-identical rather
 * than merely equivalent.
 *
 * Under `roas`/`cpa` it resolves the arm set ONCE (the pool scale is a property
 * of the SET, not of an arm) and refuses in two documented ways, both of which
 * hand the whole decision back to the click layer with a stamp:
 *  - `no_arm_evidence` — not one arm cleared `hasObjectiveEvidence`. Ranking on
 *    a ruler nothing can be measured on would be ranking on the prior.
 *  - `no_pool_scale`   — some arms cleared it, but the set has no clicks, so
 *    there is no honest price for the arms that did not. Without one, every
 *    below-floor arm would draw exactly 0 and exploration would starve.
 */
interface ObjectiveRuler {
  objective: CreativeObjective;
  poolScale: number;
}

type RulerResolution =
  | { kind: 'click' }
  | { kind: 'objective'; ruler: ObjectiveRuler }
  | { kind: 'fallback'; reason: NonNullable<SamplerDecision['objectiveFallback']> };

function resolveRuler(arms: Arm[], objective: CreativeObjective): RulerResolution {
  if (objectiveRanksOnClicks(objective)) return { kind: 'click' };
  const evidences = arms
    .map((arm) => arm.evidence)
    .filter((evidence): evidence is ObjectiveEvidence => evidence !== undefined);
  if (!evidences.some((evidence) => hasObjectiveEvidence(evidence))) {
    return { kind: 'fallback', reason: 'no_arm_evidence' };
  }
  const poolScale = objectivePoolScale(objective, evidences);
  if (!(poolScale > 0)) return { kind: 'fallback', reason: 'no_pool_scale' };
  return { kind: 'objective', ruler: { objective, poolScale } };
}

/**
 * One arm's ranked curve. An arm ABOVE the objective floors is ranked on its
 * own purchases-per-impression posterior scaled by its own value-per-purchase;
 * an arm BELOW them is ranked on its CLICK curve scaled by the set's pooled
 * value-per-click, and says so. Either way it is exactly ONE Beta curve, so the
 * raffle still costs exactly one `sampleBeta` per arm in arm order.
 */
function rankedCurve(arm: Arm, layer: BeliefLayer, ruler: ObjectiveRuler | null): ScaledCurve {
  if (!ruler) return scaleCurve(curveFor(arm, layer), 1, false);
  if (hasObjectiveEvidence(arm.evidence)) {
    return scaleCurve(
      objectivePurchaseCurve(arm.evidence),
      objectiveValueScale(ruler.objective, arm.evidence),
      false
    );
  }
  return scaleCurve(curveFor(arm, layer), ruler.poolScale, true);
}

/** The optional per-decision stamp: the ruler, and any set-wide refusal. */
function objectiveStamp(
  objective: CreativeObjective,
  resolution: RulerResolution
): Pick<SamplerDecision, 'objective' | 'objectiveFallback'> {
  if (objective === DEFAULT_CREATIVE_OBJECTIVE) return {};
  return {
    objective,
    ...(resolution.kind === 'fallback' ? { objectiveFallback: resolution.reason } : {}),
  };
}

/**
 * KEY ORDER IS LOAD-BEARING: `{ value, draw?, mean, ci95 }` is the spelling the
 * arena's snapshot fingerprint and every recorded sampler stamp already carry,
 * and `JSON.stringify` preserves insertion order. `objectiveFallback` appends
 * LAST and only when it fired, so a default-objective record is byte-identical.
 */
const armRecord = (value: string, ranked: ScaledCurve, draw?: number): SamplerArmRecord => ({
  value,
  ...(draw !== undefined ? { draw } : {}),
  mean: ranked.mean,
  ci95: ranked.ci95,
  ...(ranked.fallback ? { objectiveFallback: true as const } : {}),
});

/**
 * The Thompson raffle: one `sampleBeta` ticket per arm (in arm order, from the
 * injected rng), highest ticket wins, first-encountered wins exact ties. Returns
 * null on an empty arm set — the caller falls back; no throw ceremony.
 *
 * `objective` (default `ctr`) selects the ruler — see `resolveRuler`. The rng
 * CONTRACT is unchanged on every path: exactly one `sampleBeta` per arm, in arm
 * order. The (α, β) it is called with differ under `roas`/`cpa`, so the number
 * of uniforms the rejection sampler consumes differs too — that has always been
 * variable (the module docblock's ORDER contract), and under the default
 * objective the arguments are identical to pre-objective-layer.
 */
export function thompsonPick(
  arms: Arm[],
  layer: BeliefLayer,
  rng: () => number,
  objective: CreativeObjective = DEFAULT_CREATIVE_OBJECTIVE
): SamplerDecision | null {
  if (arms.length === 0) return null;
  const resolution = resolveRuler(arms, objective);
  const ruler = resolution.kind === 'objective' ? resolution.ruler : null;
  const records = arms.map((arm) => {
    const ranked = rankedCurve(arm, layer, ruler);
    return {
      arm,
      ranked,
      draw: sampleBeta(ranked.curve.alpha, ranked.curve.beta, rng) * ranked.scale,
    };
  });
  let best = records[0];
  for (const record of records) {
    if (record.draw > best.draw) best = record;
  }
  const maxMean = records.reduce((max, r) => (r.ranked.mean > max ? r.ranked.mean : max), 0);
  return {
    strategy: 'thompson',
    layer,
    picked: { dimension: best.arm.dimension, value: best.arm.value },
    mode: best.ranked.mean >= maxMean ? 'exploit' : 'explore',
    arms: records.map((r) => armRecord(r.arm.value, r.ranked, r.draw)),
    ...objectiveStamp(objective, resolution),
  };
}

/**
 * The deliberate explore pick for Workstream E's reserved slots: the arm with the
 * WIDEST credible interval — maximum uncertainty, i.e. the most informative test.
 * Deterministic, consumes no randomness; first-encountered wins exact width ties.
 *
 * Width is measured on the RANKED curve, so under `roas` the widest arm is the
 * one most uncertain in the objective's own units — a wide click band on an arm
 * whose clicks are worth nothing is not the most informative test of value.
 */
export function widestCurvePick(
  arms: Arm[],
  layer: BeliefLayer,
  objective: CreativeObjective = DEFAULT_CREATIVE_OBJECTIVE
): SamplerDecision | null {
  if (arms.length === 0) return null;
  const resolution = resolveRuler(arms, objective);
  const ruler = resolution.kind === 'objective' ? resolution.ruler : null;
  const ranked = arms.map((arm) => ({ arm, curve: rankedCurve(arm, layer, ruler) }));
  let best = ranked[0];
  let bestWidth = best.curve.ci95[1] - best.curve.ci95[0];
  for (const entry of ranked) {
    const width = entry.curve.ci95[1] - entry.curve.ci95[0];
    if (width > bestWidth) {
      best = entry;
      bestWidth = width;
    }
  }
  return {
    strategy: 'widest',
    layer,
    picked: { dimension: best.arm.dimension, value: best.arm.value },
    mode: 'explore',
    arms: ranked.map((entry) => armRecord(entry.arm.value, entry.curve)),
    ...objectiveStamp(objective, resolution),
  };
}

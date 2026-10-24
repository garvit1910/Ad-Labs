/**
 * Composite "win score" (0–100) and winner classification for a competitor ad.
 * Ad Library ads carry no spend/ROAS, so the score is a survival-and-scale
 * proxy: how long the ad has run, how hard the brand replicates it, and — where
 * Meta reports it — its EU reach.
 *
 * The score is ABSOLUTE: every leg is normalized against a fixed curve
 * (`win-score-constants.ts`), never against the other ads in the current
 * scope. So it is comparable across competitors and stable across views — an
 * ad scores the same alone, beside every competitor, or in the industry
 * catalog. (Before 2026-09-23 replication and reach were divided by the scope
 * max, which handed every competitor's biggest cluster a full 1.0 and, with
 * the post-boost clamp, pinned dozens of ads per competitor at exactly 100.)
 *
 * Both the score and the winner test are driven by a resolved `WinProfile`
 * (see win-profile.ts) so the rule can vary by `platform × surface × brandType`.
 * Every profile argument is OPTIONAL and defaults to the Meta profile. Since
 * Meta went cohort-relative (2026-07-21), a cohort-less `isWinner(ad)` call is
 * FLOOR-ONLY (active && >= 30d) — real winner surfaces must classify through
 * `buildWinnerEvaluator` (dashboard.ts), which threads the cohort thresholds.
 *
 * "Replication" here is the size of the ad's semantic message-family cluster
 * (how many ads the brand runs in that one angle), not the LLM angle label.
 */

import { META_PROFILE, type WinProfile } from './win-profile';
import {
  REACH_FLOOR,
  REACH_SATURATION,
  REPLICATION_SATURATION_VARIANTS,
} from './win-score-constants';

// Re-export the constants from their split-out module so existing importers
// (the dashboard route, tests) keep importing them from '@/lib/brand-identity/win-score'.
export {
  ACTIVE_BOOST,
  LONGEVITY_SATURATION_DAYS,
  REACH_FLOOR,
  REACH_SATURATION,
  REPLICATION_SATURATION_VARIANTS,
  WIN_SCORE_THRESHOLD,
  WIN_WEIGHTS_EU,
  WIN_WEIGHTS_NO_REACH,
} from './win-score-constants';

/** The minimal ad shape the scorer needs. EnrichedAd / EnrichedAdRow both satisfy it. */
export interface ScorableAd {
  eu_total_reach: number | null;
  longevity_days: number;
  is_active: boolean;
  /** Google: the actor's own served-day count (null/absent for Meta). */
  num_served_days?: number | null;
}

function clamp01(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

/**
 * The longevity figure a profile scores/classifies on. Google profiles prefer
 * the actor's `num_served_days` (immune to the lastShown-lag that distorts the
 * firstSeen→lastSeen span); everything else uses `longevity_days` from the view.
 */
export function longevityBasis(ad: ScorableAd, profile: WinProfile): number {
  if (profile.useServedDaysBasis && ad.num_served_days != null) {
    return ad.num_served_days;
  }
  return ad.longevity_days;
}

/**
 * Replication leg in [0,1]: log2(clusterSize) / log2(saturation). A singleton
 * earns 0; every doubling of the cluster earns the same increment; full at
 * `REPLICATION_SATURATION_VARIANTS`. Absolute — the same cluster size scores
 * the same for every competitor.
 */
export function replicationNorm(clusterSize: number): number {
  if (!(clusterSize > 1)) return 0;
  return clamp01(Math.log2(clusterSize) / Math.log2(REPLICATION_SATURATION_VARIANTS));
}

/**
 * Reach leg in [0,1]: log10 between `REACH_FLOOR` (0) and `REACH_SATURATION`
 * (1). Absolute — a reach of 1 person no longer earns a full leg just because
 * it is the only EU ad in scope.
 */
export function reachNorm(reach: number): number {
  if (!(reach > REACH_FLOOR)) return 0;
  return clamp01(Math.log10(reach / REACH_FLOOR) / Math.log10(REACH_SATURATION / REACH_FLOOR));
}

/**
 * Composite win score in [0,100], driven by a profile.
 * - longevityNorm = min(longevityBasis, profile.cap) / profile.cap
 * - replNorm      = replicationNorm(clusterSize)            (absolute log curve)
 * - reachNorm     = (eu_reach profile, ad has reach) ? reachNorm(reach) : n/a
 *
 * With the scale signal present:  base = w.longevity·L + w.replication·R + w.scale·reach
 * Otherwise (no scale signal, or an eu_reach profile on a null-reach ad):
 *                                 base = noScale.longevity·L + noScale.replication·R
 * score = round(base · 100 · (is_active ? 1 : 1 / activeBoost))
 *
 * The active factor is applied as a discount on stopped ads, so an active ad
 * at every cap scores exactly 100 and the scale never clamps — two ads that
 * differ above the old cap now differ in the score too.
 */
export function computeWinScore(
  ad: ScorableAd,
  clusterSize: number,
  profile: WinProfile = META_PROFILE
): number {
  const longevityNorm = clamp01(longevityBasis(ad, profile) / profile.longevityCapDays);
  const replNorm = replicationNorm(clusterSize);

  const hasScale = profile.scaleSignal === 'eu_reach' && ad.eu_total_reach != null;

  let base: number;
  if (hasScale) {
    base =
      profile.weights.longevity * longevityNorm +
      profile.weights.replication * replNorm +
      profile.weights.scale * reachNorm(ad.eu_total_reach!);
  } else {
    base =
      profile.noScaleWeights.longevity * longevityNorm +
      profile.noScaleWeights.replication * replNorm;
  }

  const activeFactor = ad.is_active ? 1 : 1 / profile.activeBoost;
  return Math.round(clamp01(base) * 100 * activeFactor);
}

/* ── cohort-relative winner thresholds ──────────────────────────────────── */

export interface CohortStat {
  /** The profile.relativeQuantile-th percentile of longevityBasis in the cohort. */
  quantileLongevity: number;
  size: number;
}
export interface CohortThresholds {
  byCohort: Map<string, CohortStat>;
}
export interface WinnerCohort {
  thresholds: CohortThresholds;
  key: string;
}

/** Value at quantile q (0..1) of an ascending-sorted array; ads >= it are the top (1-q). */
function quantileValue(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length));
  return sortedAsc[idx];
}

/**
 * Per-cohort longevity quantile + size, used by relative-mode `isWinner`. Reads
 * only the longevity basis and the cohort key — never the replication clustering
 * — so the per-competitorId clustering boundary is untouched.
 */
export function buildCohortThresholds<T extends ScorableAd>(
  rows: T[],
  keyOf: (_ad: T) => string,
  profileOf: (_ad: T) => WinProfile
): CohortThresholds {
  const valsByCohort = new Map<string, number[]>();
  const profileByCohort = new Map<string, WinProfile>();
  for (const ad of rows) {
    const key = keyOf(ad);
    const profile = profileOf(ad);
    profileByCohort.set(key, profile);
    const basis = longevityBasis(ad, profile);
    const arr = valsByCohort.get(key);
    if (arr) arr.push(basis);
    else valsByCohort.set(key, [basis]);
  }
  const byCohort = new Map<string, CohortStat>();
  for (const [key, vals] of valsByCohort) {
    vals.sort((a, b) => a - b);
    const profile = profileByCohort.get(key)!;
    byCohort.set(key, {
      quantileLongevity: quantileValue(vals, profile.relativeQuantile),
      size: vals.length,
    });
  }
  return { byCohort };
}

/**
 * Proven-winner classifier. Default (Meta profile, no cohort) degrades to the
 * floor alone — `is_active && longevity_days >= 30` — because relative mode
 * needs cohort thresholds; winner surfaces classify via `buildWinnerEvaluator`.
 *
 * - Absolute floor (always): (!requireActive || is_active) && basis >= threshold.
 * - Relative mode: additionally require basis >= the cohort quantile, but only
 *   when the cohort is large enough (>= minCohortForRelative); small cohorts use
 *   the floor alone so we never pick "the top quartile of 3 ads".
 */
export function isWinner(
  ad: ScorableAd,
  profile: WinProfile = META_PROFILE,
  cohort?: WinnerCohort
): boolean {
  const basis = longevityBasis(ad, profile);
  const floorOk =
    (!profile.requireActiveForWinner || ad.is_active) &&
    basis >= profile.longevityThresholdDays;

  if (profile.mode !== 'relative' || !cohort) return floorOk;

  const stat = cohort.thresholds.byCohort.get(cohort.key);
  if (!stat || stat.size < profile.minCohortForRelative) return floorOk;
  return floorOk && basis >= stat.quantileLongevity;
}

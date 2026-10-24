/**
 * Purchase-basis resolution — which purchase ruler a rollup cell is allowed to
 * be judged on. PURE.
 *
 * Two purchase counts exist per `ad_daily_metrics` row: what the platform
 * claims (`purchases`) and what Adcero's own attribution verified
 * (`enhanced_purchases`). Picking between them is NOT a null check.
 *
 * `enhancedCoverage` looks like the right gate and is not: it is the share of
 * contributing daily ROWS the reconciler touched, and
 * `reconcileEnhancedMetrics` blanket-writes explicit ZEROES (not NULLs) across
 * its whole org+date scope before aggregating ("Explicit zeroes prevent NULL
 * ambiguity" — lib/attribution/reconcile-enhanced-metrics.ts). So every
 * reconciled row counts as reconciled and coverage saturates to 1.0 even when
 * the verified layer caught nothing. Gating on it made `attributedRoas` 0
 * rather than null for every cell, which made basis selection always
 * 'attributed' at roas 0, which made the max-by-ROAS reduce in `priors.ts`
 * degenerate to "first sorted row wins".
 *
 * The honest statistic is CAPTURE RATIO: of the purchases the platform
 * claimed, the share our own attribution actually caught.
 *
 * Two structural rules, not advisory ones:
 *  1. Verified basis requires capture >= CAPTURE_RATIO_MIN_FOR_VERIFIED AND a
 *     non-trivial absolute platform-purchase count. A 3-of-3 cell is 100%
 *     capture and means nothing.
 *  2. Verified basis NEVER crosses platforms. Only Meta has a working verified
 *     layer: Google metric rows are written against synthetic
 *     `google-campaign-metrics-ad:<campaignId>` ids that no attribution result
 *     can ever match (lib/google-ads/sync/data-saver.ts), and the reconciler
 *     zeroes them anyway. Comparing verified-basis numbers across platforms
 *     would make Google look dead because it has no verified data, not because
 *     it performs worse.
 */

import type { MetricBasis } from './types';

/** Minimum verified÷claimed share before the verified ruler may be trusted. */
export const CAPTURE_RATIO_MIN_FOR_VERIFIED = 0.8;

/**
 * Minimum platform-claimed purchases before capture ratio is meaningful at all.
 * Below this the ratio is dominated by small-count noise (1 of 1 = 100%).
 */
export const VERIFIED_BASIS_MIN_PURCHASES = 25;

/**
 * Platforms whose verified layer is real. Meta only — see rule 2 above. This is
 * the structural enforcement point; do not re-derive it per call site.
 */
export const VERIFIED_BASIS_PLATFORMS: ReadonlySet<string> = new Set(['meta']);

/**
 * Verified ÷ platform-claimed purchases. Null when the denominator is absent or
 * zero (no claim to measure capture against) or the verified layer never ran.
 */
export function computeCaptureRatio(
  purchases: number,
  enhancedPurchases: number | null
): number | null {
  if (enhancedPurchases === null) return null;
  if (!Number.isFinite(purchases) || purchases <= 0) return null;
  if (!Number.isFinite(enhancedPurchases)) return null;
  return enhancedPurchases / purchases;
}

export interface BasisInput {
  platform: string;
  purchases: number;
  enhancedPurchases: number | null;
}

export interface BasisResolution {
  basis: MetricBasis;
  captureRatio: number | null;
}

/**
 * Resolve the purchase basis for one rollup cell, and report the capture ratio
 * that decided it (null when it could not be computed — the cell is on platform
 * basis in that case, which is the safe default).
 */
export function resolveMetricBasis(input: BasisInput): BasisResolution {
  const captureRatio = computeCaptureRatio(input.purchases, input.enhancedPurchases);

  if (!VERIFIED_BASIS_PLATFORMS.has(input.platform)) {
    return { basis: 'platform', captureRatio };
  }
  if (captureRatio === null) {
    return { basis: 'platform', captureRatio };
  }
  if (input.purchases < VERIFIED_BASIS_MIN_PURCHASES) {
    return { basis: 'platform', captureRatio };
  }
  if (captureRatio < CAPTURE_RATIO_MIN_FOR_VERIFIED) {
    return { basis: 'platform', captureRatio };
  }
  return { basis: 'attributed', captureRatio };
}

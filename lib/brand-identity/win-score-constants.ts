/**
 * Pure win-score constants, split out so `win-profile.ts` and `win-score.ts`
 * can both import them without a circular dependency. These are the Meta
 * calibration numbers; `win-profile.ts` composes them into the Meta profile.
 *
 * Every normalization here is ABSOLUTE (a fixed curve), never relative to the
 * ads that happen to be in the current dropdown scope. That is what makes a
 * score comparable across competitors: a 100 for Midas means the same thing as
 * a 100 for Jiffy Lube, and an ad keeps its score whether it is viewed alone,
 * beside every other competitor, or inside an industry catalog.
 */

/** Weights when EU reach is present. Sum to 1. */
export const WIN_WEIGHTS_EU = {
  longevity: 0.4,
  replication: 0.4,
  reach: 0.2,
} as const;

/** Weights when no reach is available (non-EU ads). Sum to 1. */
export const WIN_WEIGHTS_NO_REACH = {
  longevity: 0.5,
  replication: 0.5,
} as const;

/**
 * A still-delivering ad scores this multiple above an otherwise identical
 * stopped ad. Applied as a DISCOUNT on stopped ads (÷1.15), not a boost on
 * active ones, so the scale tops out at exactly 100 for an active ad at every
 * cap and nothing above it is ever clamped away.
 */
export const ACTIVE_BOOST = 1.15;
/** Longevity saturates here so one ancient ad can't flatten the curve for everyone. */
export const LONGEVITY_SATURATION_DAYS = 120;
/**
 * Replication is log-scaled: each DOUBLING of the ad's message-family cluster
 * (1 → 2 → 4 → … → 128 variants) earns the same increment, and the leg is full
 * at 128 variants. Cluster sizes come from the per-competitor scrape (250 ads
 * max), so 128 is the practical ceiling; a 16-variant angle earns 4/7 of the
 * leg, a 64-variant angle 6/7. A singleton (no cluster) earns nothing.
 */
export const REPLICATION_SATURATION_VARIANTS = 128;
/**
 * EU reach is log-scaled between these bounds: at or below the floor the leg
 * contributes nothing, at or above the saturation it is full. Calibrated on the
 * library's reported-reach distribution (dev, 2026-09-23, n=1,036): p50 ≈ 26k,
 * p75 ≈ 220k, p90 ≈ 1.0M, max 15M — so the top decile of EU ads max the leg.
 */
export const REACH_FLOOR = 100;
export const REACH_SATURATION = 1_000_000;
/** Composite score at/above which the hero treats an ad as a standout. */
export const WIN_SCORE_THRESHOLD = 60;

/**
 * Win profiles — the calibration surface for "what counts as a winning ad",
 * keyed by `platform × surface × brandType`. A single absolute rule
 * (active && longevity_days >= 60, tuned for Meta DTC) cannot fit Google,
 * because "how long an ad runs" means completely different things across
 * platforms and ad surfaces. The Phase-1 dev-DB investigation showed the gap
 * concretely (longevity_days, June 2026):
 *
 *   - google:video  (e.g. Cadbury brand films): median 13d, p75 21d  → flighted,
 *     short-lived. A 60d bar is unreachable; only ~2/250 ever clear it.
 *   - google:text   (evergreen Search ads):      median 138d, p75 143d → run for
 *     months at ~zero cost. A 60d bar labels ~83% of them "winners".
 *   - meta:                                       median 31d, p75 59d  → the bar
 *     the 60d/120-cap weights were calibrated against.
 *
 * So winner detection is profile-driven. Both Meta and Google are
 * cohort-relative (top-quartile within the competitor's own surface cohort)
 * with a low absolute floor; Google additionally drops the `is_active`
 * requirement — Google `is_active` is a stale inference (last_seen_at within 5d
 * of sync) that reads false for any competitor not synced in the last 5 days.
 *
 * Meta went relative 2026-07-21 (was absolute `active && >= 60d`): a freshly
 * tracked/launched advertiser whose entire library is younger than 60d (Ember
 * Wellness: 114 ads, max 48d) read 0 winners on every surface, which carries no
 * signal. Relative mode surfaces its genuinely best-performing quartile while
 * the 30d floor keeps short test flights from ever counting.
 */

import { WINNER_MIN_DAYS } from './longevity';
import {
  ACTIVE_BOOST,
  LONGEVITY_SATURATION_DAYS,
  WIN_WEIGHTS_EU,
  WIN_WEIGHTS_NO_REACH,
} from './win-score-constants';

export type ScaleSignal = 'eu_reach' | 'none';
export type WinMode = 'absolute' | 'relative';
/** Advertiser archetype. Stored on tracked_competitors.brand_type (Phase 4). */
export type BrandType = 'dtc_performance' | 'brand_cpg' | 'unknown';
export type Surface = 'text' | 'image' | 'video' | 'meta';
export type WinPlatform = 'meta' | 'google' | 'tiktok';

export interface WinProfile {
  /** Stable id; also the per-cohort discriminator suffix. */
  key: string;
  /** The absolute winner floor (Meta: WINNER_MIN_DAYS). In relative mode this is
   *  the minimum an ad must clear in addition to the cohort quantile. */
  longevityThresholdDays: number;
  /** Longevity-score normalization cap. */
  longevityCapDays: number;
  /** Score weights when the scale signal is present. Sum to 1. */
  weights: { longevity: number; replication: number; scale: number };
  /** Score weights when no scale signal applies (Meta non-EU, or scaleSignal
   *  'none'). Sum to 1 — replaces the legacy WIN_WEIGHTS_NO_REACH branch. */
  noScaleWeights: { longevity: number; replication: number };
  scaleSignal: ScaleSignal;
  activeBoost: number;
  mode: WinMode;
  requireActiveForWinner: boolean;
  /** Top-quantile cutoff for relative mode (0.75 = top quartile). */
  relativeQuantile: number;
  /** Below this cohort size, relative mode falls back to the absolute floor. */
  minCohortForRelative: number;
  /** Google: prefer the actor's num_served_days over the firstSeen→lastSeen span. */
  useServedDaysBasis: boolean;
}

/**
 * Meta's absolute winner floor in relative mode. Bucket-aligned (the 30–60d
 * `LONGEVITY_BUCKETS` boundary): an ad must have survived past the typical
 * test/learning window before the cohort quantile can crown it, and a small
 * cohort (< minCohortForRelative) falls back to this floor alone. The 60d
 * `WINNER_MIN_DAYS` remains only as the top display bucket in longevity.ts.
 */
export const META_RELATIVE_FLOOR_DAYS = 30;

/**
 * Meta — cohort-relative since 2026-07-21 (top quartile of the competitor's
 * own ads, 30d floor, still active-required — Meta `is_active` is real
 * delivery status, unlike Google's stale inference). The SCORE weights are the
 * legacy numbers: EU ads earn the reach leg; non-EU degrade to noScaleWeights
 * at score time (the old EU/non-EU split). Each leg is normalized on an
 * absolute curve (win-score-constants.ts), never against the scope max.
 */
export const META_PROFILE: WinProfile = {
  key: 'meta',
  longevityThresholdDays: META_RELATIVE_FLOOR_DAYS,
  longevityCapDays: LONGEVITY_SATURATION_DAYS,
  weights: {
    longevity: WIN_WEIGHTS_EU.longevity,
    replication: WIN_WEIGHTS_EU.replication,
    scale: WIN_WEIGHTS_EU.reach,
  },
  noScaleWeights: {
    longevity: WIN_WEIGHTS_NO_REACH.longevity,
    replication: WIN_WEIGHTS_NO_REACH.replication,
  },
  scaleSignal: 'eu_reach',
  activeBoost: ACTIVE_BOOST,
  mode: 'relative',
  requireActiveForWinner: true,
  relativeQuantile: 0.75,
  minCohortForRelative: 10,
  useServedDaysBasis: false,
};

/** Neutral fallback for TikTok / unknown platforms — Meta non-EU math, absolute. */
export const NEUTRAL_PROFILE: WinProfile = {
  key: 'neutral',
  longevityThresholdDays: WINNER_MIN_DAYS,
  longevityCapDays: LONGEVITY_SATURATION_DAYS,
  weights: { longevity: 0.5, replication: 0.5, scale: 0 },
  noScaleWeights: { longevity: 0.5, replication: 0.5 },
  scaleSignal: 'none',
  activeBoost: ACTIVE_BOOST,
  mode: 'absolute',
  requireActiveForWinner: true,
  relativeQuantile: 0.75,
  minCohortForRelative: 10,
  useServedDaysBasis: false,
};

/**
 * Google video/image — expensive, deliberately-kept-live creatives that flight.
 * Cohort-relative (top quartile of the same surface) with a 14d floor so a 45d
 * brand film among 3-week films wins, but a 5d test never does. Longevity-led
 * score; no commercial reach/spend, so two legs.
 */
export const GOOGLE_VISUAL_PROFILE: WinProfile = {
  key: 'google:visual',
  longevityThresholdDays: 14,
  longevityCapDays: 60,
  weights: { longevity: 0.6, replication: 0.4, scale: 0 },
  noScaleWeights: { longevity: 0.6, replication: 0.4 },
  scaleSignal: 'none',
  activeBoost: ACTIVE_BOOST,
  mode: 'relative',
  requireActiveForWinner: false,
  relativeQuantile: 0.75,
  minCohortForRelative: 10,
  useServedDaysBasis: true,
};

/**
 * Google text/Search — evergreen, near-zero-cost defaults that all run for
 * months, so longevity barely discriminates (p25 108d, p75 143d, ties at the
 * cap). Relative within the text cohort + replication-led score so a winner is
 * the genuinely-replicated/standout one, not "every Search ad".
 */
export const GOOGLE_TEXT_PROFILE: WinProfile = {
  key: 'google:text',
  longevityThresholdDays: 14,
  longevityCapDays: 60,
  weights: { longevity: 0.35, replication: 0.65, scale: 0 },
  noScaleWeights: { longevity: 0.35, replication: 0.65 },
  scaleSignal: 'none',
  activeBoost: ACTIVE_BOOST,
  mode: 'relative',
  requireActiveForWinner: false,
  relativeQuantile: 0.75,
  minCohortForRelative: 10,
  useServedDaysBasis: true,
};

export interface ProfileKey {
  platform: WinPlatform | string;
  brandType: BrandType;
  surface: Surface;
}

/**
 * Resolve the profile for an ad's cohort. Surface drives Google selection;
 * brandType is accepted for forward-compatibility (Phase 4 may branch Google
 * weights by archetype) but does not yet change the returned profile.
 */
export function resolveWinProfile({ platform, surface }: ProfileKey): WinProfile {
  if (platform === 'google') {
    return surface === 'text' ? GOOGLE_TEXT_PROFILE : GOOGLE_VISUAL_PROFILE;
  }
  if (platform === 'meta') return META_PROFILE;
  return NEUTRAL_PROFILE;
}

/**
 * Maps an ad to its surface. Google distinguishes text(Search)/image(Display)/
 * video(YouTube); everything else collapses to the single 'meta' surface.
 */
export function adSurface(row: { platform: string; media_type: string | null }): Surface {
  if (row.platform === 'google') {
    switch (row.media_type) {
      case 'text':
        return 'text';
      case 'video':
        return 'video';
      default:
        return 'image'; // image, carousel, unknown, null
    }
  }
  return 'meta';
}

/**
 * The cohort relative-mode ranks within: a single competitor's own surface
 * (platform × surface × competitor). "Winning" is relative to the same
 * advertiser's same-surface ads — a 45-day brand film among that brand's
 * 3-week films wins. Keying by competitor (not a pooled platform/brand-type
 * bucket) makes the per-competitor winnerCount, the single-competitor
 * dashboard, and the all-competitors view all reconcile to the same number.
 */
export function cohortKey(row: {
  platform: string;
  media_type: string | null;
  competitor_id: string;
}): string {
  return `${row.platform}:${adSurface(row)}:${row.competitor_id}`;
}

/**
 * Longevity buckets for competitor library ads. Single source of truth for
 * the thresholds used by the longevity badge, the per-competitor
 * distribution chart, and overview stats.
 *
 * The day count itself is computed in SQL by the `library_ads_enriched`
 * view (`longevity_days`); this module only owns the bucketing.
 */

export const LONGEVITY_BUCKETS = [
  { key: 'lt14', label: '< 14 days', minDays: 0 },
  { key: 'd14_30', label: '14–30 days', minDays: 14 },
  { key: 'd30_60', label: '30–60 days', minDays: 30 },
  { key: 'winner', label: '60+ days', minDays: 60 },
] as const;

export type LongevityBucketKey = (typeof LONGEVITY_BUCKETS)[number]['key'];

/** Top display bucket boundary ("60+ days"). NO LONGER the Meta winner bar —
 *  winner classification is cohort-relative (win-profile.ts META_PROFILE,
 *  30d floor + top cohort quartile); this constant only drives the bucket
 *  chart and the neutral (TikTok/unknown) profile's absolute threshold. */
export const WINNER_MIN_DAYS = 60;

export function longevityBucket(days: number): LongevityBucketKey {
  if (days >= 60) return 'winner';
  if (days >= 30) return 'd30_60';
  if (days >= 14) return 'd14_30';
  return 'lt14';
}

/**
 * Pure sentiment-mix fold over clustered VOC themes. No IO, no React — shared
 * by the Pulse Overview (`components/brand-presence/pulse-metrics.ts`
 * re-exports it) and the Brand Identity report's competitive-landscape
 * summary (`lib/brand-presence/competitive-landscape.ts`), so both surfaces
 * compute the same number from the same theme rows.
 */

export interface SentimentMix {
  /** Weighted positive share, 0–100, or null when nothing is scored yet. */
  score: number | null;
  positivePct: number;
  neutralPct: number;
  negativePct: number;
  /** Total frequency weight of themes that carry a sentiment. */
  scoredWeight: number;
}

/** The two theme columns the fold reads — structural so lib never depends on
 * a hook's inferred type. */
export interface SentimentMixTheme {
  frequency: number;
  avg_sentiment: number | null;
}

/**
 * Weighted positive/neutral/negative split across themes. Each theme is
 * weighted by `max(1, frequency)`; buckets use the same ±0.2 thresholds as
 * the theme cards. Themes with a null `avg_sentiment` are excluded entirely.
 * With no scored themes the score is null and every percentage is 0.
 */
export function computeSentimentMix(themes: SentimentMixTheme[]): SentimentMix {
  let positiveWeight = 0;
  let neutralWeight = 0;
  let negativeWeight = 0;

  for (const theme of themes) {
    if (theme.avg_sentiment == null) continue;
    const weight = Math.max(1, theme.frequency);
    if (theme.avg_sentiment > 0.2) positiveWeight += weight;
    else if (theme.avg_sentiment < -0.2) negativeWeight += weight;
    else neutralWeight += weight;
  }

  const scoredWeight = positiveWeight + neutralWeight + negativeWeight;
  if (scoredWeight === 0) {
    return {
      score: null,
      positivePct: 0,
      neutralPct: 0,
      negativePct: 0,
      scoredWeight: 0,
    };
  }

  return {
    score: Math.round((100 * positiveWeight) / scoredWeight),
    positivePct: Math.round((100 * positiveWeight) / scoredWeight),
    neutralPct: Math.round((100 * neutralWeight) / scoredWeight),
    negativePct: Math.round((100 * negativeWeight) / scoredWeight),
    scoredWeight,
  };
}

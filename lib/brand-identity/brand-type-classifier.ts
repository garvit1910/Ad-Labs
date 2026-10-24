/**
 * ADVISORY advertiser brand-type classifier. Produces a *suggestion* only — it
 * is written to `tracked_competitors.scores.brandTypeSuggestion` for a human (or
 * agent) to confirm, and NEVER auto-commits the `brand_type` column. brand_type
 * changes the entire winner set, so the committed value must stay deterministic
 * and explainable; this heuristic merely proposes one.
 *
 * Signals are derived from a competitor's own ad corpus and reflect the Phase-1
 * archetype split:
 *   - brand_cpg     — few-but-polished, flighted (stop after a burst), video-led
 *                     brand films; short median longevity, low active ratio.
 *   - dtc_performance — many always-on variants, image/mixed creative, longer
 *                     active tails.
 * When signals are weak or conflicting it returns `unknown` (the neutral
 * profile), so a misclassification never silently swings scoring.
 */

import type { BrandType } from './win-profile';

export interface BrandTypeSignals {
  adCount: number;
  /** Share of ads still delivering (deliveryStop == null), 0..1. */
  activeRatio: number;
  /** Share of ads whose media is video, 0..1. */
  videoShare: number;
  /** Share of ads whose media is text/Search, 0..1. */
  textShare: number;
  /** Median longevity (served/delivering days) across the corpus. */
  medianLongevityDays: number;
}

export interface BrandTypeSuggestion {
  brandType: BrandType;
  /** 0..1 — only suggestions at/above MIN_CONFIDENCE escape 'unknown'. */
  confidence: number;
  rationale: string;
}

/** Below this many ads there is not enough signal to suggest anything. */
export const MIN_ADS_FOR_SUGGESTION = 8;
/** A type must score at least this to beat the neutral 'unknown' default. */
export const MIN_CONFIDENCE = 0.6;

export function suggestBrandType(signals: BrandTypeSignals): BrandTypeSuggestion {
  if (signals.adCount < MIN_ADS_FOR_SUGGESTION) {
    return {
      brandType: 'unknown',
      confidence: 0,
      rationale: `Only ${signals.adCount} ads — not enough signal to classify.`,
    };
  }

  // brand_cpg: flighted (low active), video-led, short-lived bursts.
  let cpg = 0;
  const cpgWhy: string[] = [];
  if (signals.activeRatio <= 0.3) {
    cpg += 0.4;
    cpgWhy.push('flighted (few ads still delivering)');
  }
  if (signals.videoShare >= 0.5) {
    cpg += 0.35;
    cpgWhy.push('video-led creative');
  }
  if (signals.medianLongevityDays <= 30) {
    cpg += 0.25;
    cpgWhy.push('short median run');
  }

  // dtc_performance: always-on, high volume, image/mixed creative.
  let dtc = 0;
  const dtcWhy: string[] = [];
  if (signals.activeRatio >= 0.4) {
    dtc += 0.4;
    dtcWhy.push('always-on (many ads still delivering)');
  }
  if (signals.adCount >= 40) {
    dtc += 0.3;
    dtcWhy.push('high ad volume');
  }
  if (signals.videoShare < 0.5 && signals.textShare < 0.5) {
    dtc += 0.3;
    dtcWhy.push('image/mixed creative');
  }

  const cpgConf = Math.min(1, cpg);
  const dtcConf = Math.min(1, dtc);

  if (cpgConf >= MIN_CONFIDENCE && cpgConf >= dtcConf) {
    return {
      brandType: 'brand_cpg',
      confidence: cpgConf,
      rationale: `Looks like a brand/CPG advertiser: ${cpgWhy.join(', ')}.`,
    };
  }
  if (dtcConf >= MIN_CONFIDENCE) {
    return {
      brandType: 'dtc_performance',
      confidence: dtcConf,
      rationale: `Looks like a DTC performance advertiser: ${dtcWhy.join(', ')}.`,
    };
  }
  return {
    brandType: 'unknown',
    confidence: Math.max(cpgConf, dtcConf),
    rationale: 'Mixed signals — leaving as unknown (neutral) pending review.',
  };
}

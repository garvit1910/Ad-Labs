/**
 * Score↔outcome calibration (Phase 4 item 2) — the scoring system's own KPI.
 *
 * Correlates the pre-flight `rank_score` with realized CTR/ROAS via Spearman
 * rank correlation (tie-aware average ranks). The v1 rubric is EXPECTED to
 * predict little — the point is to measure that honestly and iterate the
 * ranking rubric against this number, never against taste. Min-sample gates
 * return `insufficient_sample` instead of a noise correlation.
 */

import type {
  CalibrationCorrelation,
  CalibrationSample,
  ScoreCalibrationReport,
} from './types';

export const CALIBRATION_MIN_IMPRESSIONS = 100;
export const CALIBRATION_MIN_SAMPLES = 5;

/** Tie-aware average ranks (1-based). */
function averageRanks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    const rank = (i + j + 2) / 2; // mean of 1-based positions i+1..j+1
    for (let k = i; k <= j; k += 1) ranks[indexed[k].index] = rank;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null; // constant series — correlation undefined
  return cov / Math.sqrt(varX * varY);
}

/** Spearman rank correlation; null when undefined (constant series or n < 2). */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

function correlate(
  samples: CalibrationSample[],
  outcome: (_sample: CalibrationSample) => number | null,
  minSamples: number
): CalibrationCorrelation | null {
  const pairs = samples
    .map((sample) => ({ score: sample.rankScore, outcome: outcome(sample) }))
    .filter((pair): pair is { score: number; outcome: number } => pair.outcome !== null);
  if (pairs.length < minSamples) return null;
  return {
    spearman: spearman(
      pairs.map((pair) => pair.score),
      pairs.map((pair) => pair.outcome)
    ),
    n: pairs.length,
  };
}

export interface CalibrationOptions {
  minImpressions?: number;
  minSamples?: number;
}

export function computeScoreCalibration(
  samples: CalibrationSample[],
  options: CalibrationOptions = {}
): ScoreCalibrationReport {
  const minImpressions = options.minImpressions ?? CALIBRATION_MIN_IMPRESSIONS;
  const minSamples = options.minSamples ?? CALIBRATION_MIN_SAMPLES;

  const eligible = samples.filter(
    (sample) => Number.isFinite(sample.rankScore) && sample.impressions >= minImpressions
  );
  const excluded = samples.length - eligible.length;

  const ctrOf = (sample: CalibrationSample): number | null =>
    sample.impressions > 0 ? sample.clicks / sample.impressions : null;
  const roasOf = (sample: CalibrationSample): number | null =>
    sample.spend > 0 ? sample.purchaseValue / sample.spend : null;
  const attributedRoasOf = (sample: CalibrationSample): number | null =>
    sample.spend > 0 && sample.enhancedPurchaseValue !== null
      ? sample.enhancedPurchaseValue / sample.spend
      : null;

  if (eligible.length < minSamples) {
    return {
      status: 'insufficient_sample',
      n: eligible.length,
      excluded,
      minImpressions,
      minSamples,
      ctr: null,
      roas: null,
      attributedRoas: null,
      byJudgeVersion: {},
    };
  }

  const byJudgeVersion: ScoreCalibrationReport['byJudgeVersion'] = {};
  const judgeGroups = new Map<string, CalibrationSample[]>();
  for (const sample of eligible) {
    const list = judgeGroups.get(sample.judgeVersion);
    if (list) list.push(sample);
    else judgeGroups.set(sample.judgeVersion, [sample]);
  }
  for (const [judgeVersion, group] of judgeGroups) {
    byJudgeVersion[judgeVersion] = {
      n: group.length,
      ctr: correlate(group, ctrOf, minSamples),
    };
  }

  return {
    status: 'ok',
    n: eligible.length,
    excluded,
    minImpressions,
    minSamples,
    ctr: correlate(eligible, ctrOf, minSamples),
    roas: correlate(eligible, roasOf, minSamples),
    attributedRoas: correlate(eligible, attributedRoasOf, minSamples),
    byJudgeVersion,
  };
}

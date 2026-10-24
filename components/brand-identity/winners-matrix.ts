/**
 * Pure model for the "Winners vs the rest" performance matrix. Turns a
 * DimensionOverIndex into plottable tactics (positioned in a 2x2 quadrant of
 * over-index × median win score), ranked lists, and templated insight copy. No JSX -
 * only data + lucide icon references - so it stays cheap to test.
 *
 * The icon/colour registry + quadrant metadata live in
 * ./winners-matrix-visuals.ts; re-exported here so consumers keep one import.
 */

import { median } from '@/lib/brand-identity/math';
import type { LucideIcon } from 'lucide-react';
import type {
  AnalysisDimension,
  DimensionOverIndex,
  OverIndexRow,
} from '@/lib/brand-identity/types';
import { labelText, scoreLabel } from './dashboard-shared';
import { MIN_SAMPLE } from './dimension-headline';
import {
  assignTacticVisuals,
  QUADRANTS,
  tacticVisual,
  type QuadrantKey,
} from './winners-matrix-visuals';

export { assignTacticVisuals, QUADRANTS, tacticVisual, type QuadrantKey };
export {
  SIGNAL_ACCENT,
  SIGNAL_NEUTRAL,
  signalQuadrantColor,
  type MatrixColorScheme,
} from './winners-matrix-visuals';

export interface Tactic {
  dimension: AnalysisDimension;
  label: string;
  displayLabel: string;
  lift: number;
  /**
   * Median composite win score (0..100) across this tactic's ads - the
   * winners-mode y-axis. Credits replication, not just longevity, so a lone
   * long-running ad can't read as a 100% "win rate".
   */
  medianWinScore: number;
  winnerShare: number;
  volume: number;
  winnerCount: number;
  /** Median longevity_days across this tactic's ads - the provisional rank signal. */
  medianLongevity: number;
  quadrant: QuadrantKey;
  icon: LucideIcon;
  color: string;
  /** Plot position as a 0–100 percentage of the chart area. */
  x: number;
  y: number;
  /** Top-win-score ad carrying this tactic's label; equals `exampleAdIds[0]`. */
  topAdId: string | null;
  /** All ads for this tactic, win-score-ranked - the matrix arrows through them. */
  exampleAdIds: string[];
}

export interface InsightCard {
  icon: LucideIcon;
  color: string;
  title: string;
  body: string;
}

/**
 * Structured form of `insights.takeaway` so non-English renderers can rebuild
 * the sentence from the catalog (labels are raw taxonomy ids; numbers raw).
 * The English `takeaway` string stays the source of truth for English.
 */
export type MatrixTakeawayCopy =
  | { kind: 'provisionalLowSample'; total: number; label: string; days: number }
  | { kind: 'provisionalNoWinners'; label: string; days: number }
  | { kind: 'noWinners'; min: number }
  | { kind: 'noScore'; topLift: string; lift: number }
  | { kind: 'tiedTwo'; topLift: string; lift: number; a: string; b: string; score: string }
  | { kind: 'tiedMany'; topLift: string; lift: number; count: number; score: string }
  | { kind: 'leader'; topLift: string; lift: number; label: string; score: string; count: number };

/** Why a provisional matrix is provisional (drives the "Emerging" note). */
export type MatrixProvisionalReason = 'low_sample' | 'no_winners';

/**
 * Whether the matrix is plotting real proven-winner signal (`ok`) or a
 * `provisional` ranking. Provisional kicks in when no ad has cleared the
 * longevity bar yet (so over-index / win rate all collapse to zero) OR the
 * sample is thin - instead of an empty state we rank tactics by median delivery
 * days (the continuous version of the winner bar) and label it as emerging.
 */
export type MatrixSignalState = 'ok' | 'provisional';

/** The mode-specific axis the dots/rankings are plotted against. */
export type MatrixMode = 'winners' | 'provisional';

/**
 * Below this many labeled ads in a dimension the winner-based view is noise, so
 * even if a stray winner exists we fall back to the provisional ranking.
 */
export const MIN_MATRIX_SAMPLE = 8;

/** Per-mode display metadata so the renderer never hardcodes axis semantics. */
export interface MatrixDisplay {
  xAxisLabel: string;
  yAxisLabel: string;
  /** Tick labels left→right (x): [min, mid, max]. */
  xTickLabels: [string, string, string];
  /** Tick labels top→bottom (y): [max, mid, min]. */
  yTickLabels: [string, string, string];
  /** Help-bubble text describing the axes. */
  tooltip: string;
  /** Caption under the plot (e.g. "Win score vs. usage · top-right = ..."). */
  caption: string;
  /** Quadrant titles for this mode (provisional gets its own labels). */
  quadrantTitles: Record<QuadrantKey, { title: string; subtitle: string }>;
}

export interface MatrixModel {
  dimension: AnalysisDimension;
  /** `ok` = real winners; `provisional` = emerging ranking. Gates the badge. */
  signalState: MatrixSignalState;
  /** Which axis pair the dots are plotted against. */
  mode: MatrixMode;
  tactics: Tactic[];
  xDomain: [number, number];
  yDomain: [number, number];
  /**
   * Threshold values pinned to the 50% mark by the piecewise scale (winners:
   * median lift of the plotted tactics / pooled median win score; provisional:
   * median volume / median days).
   */
  xMidValue: number;
  yMidValue: number;
  /** Divider positions as 0–100 percentages (always 50 with the piecewise scale). */
  /** Mode-aware axis labels, ticks, tooltip and quadrant titles for the renderer. */
  display: MatrixDisplay;
  /** Provisional caption shown in the panel; null in winners mode. */
  provisionalNote: string | null;
  /** Why the view is provisional (null in winners mode) - for translated notes. */
  provisionalReason: MatrixProvisionalReason | null;
  /** Labeled ads in the dimension (the provisional note's count). */
  labeledAds: number;
  rankings: {
    topOverIndex: Tactic[];
    topWinRate: Tactic[];
    lowest: Tactic[];
  };
  insights: { takeaway: string; takeawayCopy: MatrixTakeawayCopy; cards: InsightCard[] };
}

function quadrantOf(lift: number, winScore: number, xMid: number, yMid: number): QuadrantKey {
  const highWin = winScore >= yMid;
  const highLift = lift >= xMid;
  if (highWin && highLift) return 'power';
  if (highWin && !highLift) return 'common';
  if (!highWin && highLift) return 'gems';
  return 'under';
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function liftLabel(lift: number): string {
  return `${lift.toFixed(1)}×`;
}

/** Quadrant titles for the provisional (delivery-days × volume) view. */
const PROVISIONAL_QUADRANT_TITLES: Record<
  QuadrantKey,
  { title: string; subtitle: string }
> = {
  power: { title: 'Scaling & sticking', subtitle: 'High volume · long delivery' },
  common: { title: 'Sticking · niche', subtitle: 'Low volume · long delivery' },
  gems: { title: 'Scaling · early', subtitle: 'High volume · short delivery' },
  under: { title: 'Early · niche', subtitle: 'Low volume · short delivery' },
};

function buildDisplay(
  mode: MatrixMode,
  d: { xMin: number; xMid: number; xMax: number; yMin: number; yMid: number; yMax: number }
): MatrixDisplay {
  if (mode === 'winners') {
    return {
      xAxisLabel: 'Used more than all ads →',
      yAxisLabel: 'Win score →',
      xTickLabels: [liftLabel(d.xMin), liftLabel(d.xMid), liftLabel(d.xMax)],
      yTickLabels: [scoreLabel(d.yMax), scoreLabel(d.yMid), scoreLabel(d.yMin)],
      tooltip:
        'Each dot is a tactic. X-axis = how much more it is used (how much more ' +
        'it appears among proven winners than in all ads). Y-axis = median win ' +
        'score (0-100: how long its ads run, how many variations they spawn, and ' +
        'EU reach where reported). The dashed lines mark the median usage and the ' +
        `median win score across all ads. Tactics with fewer than ${MIN_SAMPLE} ads ` +
        'are not shown.',
      caption: 'Win score vs. usage · top-right = proven & most used',
      quadrantTitles: QUADRANTS,
    };
  }
  const days = (v: number) => `${Math.round(v)}d`;
  const count = (v: number) => `${Math.round(v)}`;
  return {
    xAxisLabel: 'Ad volume →',
    yAxisLabel: 'Days delivering →',
    xTickLabels: [count(d.xMin), count(d.xMid), count(d.xMax)],
    yTickLabels: [days(d.yMax), days(d.yMid), days(d.yMin)],
    tooltip:
      'No ad has cleared its platform\u2019s winner bar yet, so tactics are ranked by ' +
      'current delivery. Each dot is a tactic. X-axis = ad volume (how many ads ' +
      'run it). Y-axis = median days delivering. Top-right = scaled and sticking.',
    caption: 'Days delivering vs. ad volume · top-right = scaling & sticking',
    quadrantTitles: PROVISIONAL_QUADRANT_TITLES,
  };
}

/**
 * Builds the full matrix model for one dimension, or null when fewer than two
 * tactics clear the `MIN_SAMPLE` floor. Plots the real winner view (over-index ×
 * median win score) when proven winners exist; otherwise falls back to a
 * `provisional` ranking (ad volume × median delivery days) so the matrix always
 * populates. In both modes a tactic under `MIN_SAMPLE` ads is dropped before the
 * plot is built - it is not drawn and never moves an axis, a divider, a quadrant,
 * a ranking or an insight (a 2-ad tactic inheriting a copy family's replication
 * score is noise, not a leader). Only the mode choice and the provisional ad
 * count read every labeled ad, so that copy stays true to the dimension.
 */
export function buildMatrixModel(dimension: DimensionOverIndex): MatrixModel | null {
  const labeled = dimension.rows.filter((r) => r.totalCount > 0);
  const rows = labeled.filter((r) => r.totalCount >= MIN_SAMPLE);
  if (rows.length < 2) return null;

  // Mode + provisional copy describe the whole dimension ("only N labeled ads",
  // "no ad has cleared the winner bar"), so they count every labeled ad.
  const totalWinners = labeled.reduce((s, r) => s + r.winnerCount, 0);
  const totalAds = labeled.reduce((s, r) => s + r.totalCount, 0);

  // Fall back to the provisional ranking when no ad has cleared the longevity
  // bar (over-index / win rate all collapse to zero) or the sample is too thin
  // to trust the winner split - instead of an empty "not enough signal" state.
  const provisionalReason: 'low_sample' | 'no_winners' | null =
    totalAds < MIN_MATRIX_SAMPLE
      ? 'low_sample'
      : totalWinners === 0
        ? 'no_winners'
        : null;
  const mode: MatrixMode = provisionalReason ? 'provisional' : 'winners';
  const signalState: MatrixSignalState = mode === 'winners' ? 'ok' : 'provisional';

  // Axis values per mode: winners plot over-index (x) × median win score (y);
  // provisional plot ad volume (x) × median delivery days (y).
  const xValOf = (r: OverIndexRow) => (mode === 'winners' ? r.lift : r.totalCount);
  const yValOf = (r: OverIndexRow) => (mode === 'winners' ? r.medianWinScore : r.medianLongevity);

  const xVals = rows.map(xValOf);
  const yVals = rows.map(yValOf);

  // Threshold lines. Winners: median lift over the plotted tactics × the pooled
  // median win score over every labeled ad (by design - it is the dimension's
  // bar, not the plotted tactics'). Provisional centres on the median tactic on
  // each axis.
  const xMid = median(xVals);
  const yMid = mode === 'winners' ? dimension.medianWinScore : median(yVals);

  const xMin0 = Math.min(...xVals);
  const xMax0 = Math.max(...xVals);
  const xPad = Math.max((xMax0 - xMin0) * 0.12, 0.1);
  const xMin = Math.max(0, xMin0 - xPad);
  const xMax = xMax0 + xPad > xMin ? xMax0 + xPad : xMin + 1;

  // winners: y is a 0..100 win score padded toward 100; provisional: days from 0.
  const yMax0 = Math.max(...yVals);
  const yMin = 0;
  const yMax =
    mode === 'winners'
      ? Math.max(Math.min(100, yMax0 * 1.15 + 2), 5)
      : Math.max(yMax0 * 1.08 + 1, 1);

  // Piecewise-linear: pin each threshold to 50% so the dividers are centred and
  // all four quadrants are equal. Same thresholds → same quadrant membership; only
  // the on-screen position changes. Spreads clustered points (an outlier no longer
  // crushes the rest into a corner).
  const toHalf = (v: number, lo: number, mid: number, hi: number) => {
    const pct =
      v <= mid
        ? mid > lo
          ? ((v - lo) / (mid - lo)) * 50
          : 50
        : hi > mid
          ? 50 + ((v - mid) / (hi - mid)) * 50
          : 50;
    return clamp(pct, 4, 96);
  };
  const toX = (v: number) => toHalf(v, xMin, xMid, xMax);
  const toY = (v: number) => toHalf(v, yMin, yMid, yMax);

  // Resolve every label's visual together so accent colours are distinct across
  // the dimension (per-label hashing alone can collide - e.g. two industry angles).
  const visuals = assignTacticVisuals(
    dimension.dimension,
    rows.map((r) => r.label)
  );
  const tactics: Tactic[] = rows.map((r) => {
    const visual = visuals.get(r.label) ?? tacticVisual(dimension.dimension, r.label);
    const xVal = xValOf(r);
    const yVal = yValOf(r);
    return {
      dimension: dimension.dimension,
      label: r.label,
      displayLabel: labelText(r.label),
      lift: r.lift,
      medianWinScore: r.medianWinScore,
      winnerShare: r.winnerShare,
      volume: r.totalCount,
      winnerCount: r.winnerCount,
      medianLongevity: r.medianLongevity,
      quadrant: quadrantOf(xVal, yVal, xMid, yMid),
      icon: visual.icon,
      color: visual.color,
      x: toX(xVal),
      y: toY(yVal),
      topAdId: r.topAdId,
      exampleAdIds: r.exampleAdIds,
    };
  });

  // Rankings + insights see exactly the plotted tactics - all at/above the
  // sample floor, since sub-floor ones were dropped before the plot was built.
  const byLift = [...tactics].sort((a, b) => b.lift - a.lift);
  const byWin = [...tactics].sort(
    (a, b) => b.medianWinScore - a.medianWinScore || b.volume - a.volume
  );
  const byDays = [...tactics].sort(
    (a, b) => b.medianLongevity - a.medianLongevity || b.volume - a.volume
  );
  const byVolume = [...tactics].sort(
    (a, b) => b.volume - a.volume || b.medianLongevity - a.medianLongevity
  );

  let rankings: MatrixModel['rankings'];
  let insights: MatrixModel['insights'];
  if (mode === 'winners') {
    const underperformers = tactics
      .filter((t) => t.quadrant === 'under')
      .sort((a, b) => a.medianWinScore - b.medianWinScore);
    const lowest = (underperformers.length ? underperformers : [...byWin].reverse()).slice(0, 3);
    rankings = { topOverIndex: byLift.slice(0, 5), topWinRate: byWin.slice(0, 5), lowest };
    insights = buildInsights(tactics, byLift, byWin);
  } else {
    rankings = {
      topOverIndex: byDays.slice(0, 5),
      topWinRate: byVolume.slice(0, 5),
      lowest: [...byDays].reverse().slice(0, 3),
    };
    insights = provisionalInsights(byDays[0], totalAds, provisionalReason!);
  }

  return {
    dimension: dimension.dimension,
    signalState,
    mode,
    tactics,
    xDomain: [xMin, xMax],
    yDomain: [yMin, yMax],
    xMidValue: xMid,
    yMidValue: yMid,
    display: buildDisplay(mode, { xMin, xMid, xMax, yMin, yMid, yMax }),
    provisionalNote:
      mode === 'provisional'
        ? provisionalReason === 'low_sample'
          ? `Emerging - only ${totalAds} labeled ${totalAds === 1 ? 'ad' : 'ads'} so far; ` +
            `ranked by current delivery days, not proven winners.`
          : `Emerging - no ad has cleared its platform\u2019s winner bar yet; ` +
            `ranked by current delivery days.`
        : null,
    provisionalReason,
    labeledAds: totalAds,
    rankings,
    insights,
  };
}

/** Honest takeaway for the provisional ranking - never narrates a 0% as signal. */
function provisionalInsights(
  top: Tactic,
  totalAds: number,
  reason: 'low_sample' | 'no_winners'
): MatrixModel['insights'] {
  const lead = `${top.displayLabel} leads at ${Math.round(top.medianLongevity)} days delivering`;
  const takeaway =
    reason === 'low_sample'
      ? `Only ${totalAds} labeled ads so far - no proven winners yet. ` +
        `Ranked by how long each tactic is currently delivering: ${lead}.`
      : `No ad has cleared its platform\u2019s winner bar yet. Ranked by how long each ` +
        `tactic is currently delivering: ${lead}.`;
  const takeawayCopy: MatrixTakeawayCopy =
    reason === 'low_sample'
      ? { kind: 'provisionalLowSample', total: totalAds, label: top.label, days: Math.round(top.medianLongevity) }
      : { kind: 'provisionalNoWinners', label: top.label, days: Math.round(top.medianLongevity) };
  return { takeaway, takeawayCopy, cards: [] };
}

/**
 * Winners-mode copy over the plotted (≥ `MIN_SAMPLE`) tactics only, ranked by
 * median win score. Honest by construction: no proven winners among them gets
 * its own sentence, a field of zero scores is never ranked, and a display tie at
 * the top is called a tie rather than a single leader.
 */
function buildInsights(
  eligible: Tactic[],
  byLift: Tactic[],
  byWin: Tactic[]
): MatrixModel['insights'] {
  const topLift = byLift[0];
  const topWin = byWin[0];
  // Every proven winner may sit in a sub-floor tactic - then nothing rankable
  // has won, so over-index and the "used most" framing carry no signal.
  if (eligible.every((t) => t.winnerCount === 0)) {
    return {
      takeaway:
        `No tactic with at least ${MIN_SAMPLE} ads has a proven winner yet - not enough ` +
        `signal to rank tactics. Winners appear once ads clear the longevity bar for ` +
        `their platform.`,
      takeawayCopy: { kind: 'noWinners', min: MIN_SAMPLE },
      cards: [],
    };
  }

  const topScore = scoreLabel(topWin.medianWinScore);
  const tied = byWin.filter((t) => scoreLabel(t.medianWinScore) === topScore);
  const scoredField = topScore !== '0';

  let scoreSentence: string;
  let scoreCard: InsightCard | null = null;
  const liftCopy = { topLift: topLift.label, lift: topLift.lift };
  let takeawayCopy: MatrixTakeawayCopy;
  if (!scoredField) {
    scoreSentence = 'No tactic has a median win score above 0 yet.';
    takeawayCopy = { kind: 'noScore', ...liftCopy };
  } else if (tied.length > 1) {
    takeawayCopy =
      tied.length === 2
        ? { kind: 'tiedTwo', ...liftCopy, a: tied[0].label, b: tied[1].label, score: topScore }
        : { kind: 'tiedMany', ...liftCopy, count: tied.length, score: topScore };
    const who =
      tied.length === 2
        ? `${tied[0].displayLabel} and ${tied[1].displayLabel} are`
        : `${tied.length} tactics are`;
    scoreSentence = `${who} tied for the highest median win score (${topScore}).`;
    scoreCard = {
      icon: topWin.icon,
      color: topWin.color,
      title: 'Tied at the top',
      body: `${who} tied on median win score (${topScore}).`,
    };
  } else {
    takeawayCopy = {
      kind: 'leader',
      ...liftCopy,
      label: topWin.label,
      score: topScore,
      count: topWin.volume,
    };
    scoreSentence =
      `${topWin.displayLabel} scores highest - median win score ${topScore} across ` +
      `its ${topWin.volume} ads.`;
    scoreCard = {
      icon: topWin.icon,
      color: topWin.color,
      title: `${topWin.displayLabel} wins most`,
      body: `Median win score ${topScore} across its ${topWin.volume} ads.`,
    };
  }

  const power = eligible
    .filter((t) => t.quadrant === 'power')
    .sort((a, b) => b.medianWinScore - a.medianWinScore)[0];
  const gem = eligible
    .filter((t) => t.quadrant === 'gems')
    .sort((a, b) => b.lift - a.lift)[0];

  const takeaway =
    `${topLift.displayLabel} is used the most (${liftLabel(topLift.lift)}) - far more ` +
    `common among proven winners than in all ads. ${scoreSentence}`;

  const cards: InsightCard[] = [
    ...(scoreCard ? [scoreCard] : []),
    {
      icon: topLift.icon,
      color: topLift.color,
      title: `${topLift.displayLabel} is used most`,
      body: `${liftLabel(topLift.lift)} more common among winners than overall.`,
    },
    power
      ? {
          icon: power.icon,
          color: power.color,
          title: `${power.displayLabel} is a power performer`,
          body:
            `Strong median win score (${scoreLabel(power.medianWinScore)}) and is used ` +
            `more (${liftLabel(power.lift)}).`,
        }
      : gem
        ? {
            icon: gem.icon,
            color: gem.color,
            title: `${gem.displayLabel} is a hidden gem`,
            body:
              `Used more (${liftLabel(gem.lift)}) despite a median win score of ` +
              `${scoreLabel(gem.medianWinScore)} - one to watch.`,
          }
        : {
            icon: topLift.icon,
            color: topLift.color,
            title: 'Lean into the most used',
            body: 'The tactics on the right edge appear far more in winners than in the overall pool.',
          },
  ];

  return { takeaway, takeawayCopy, cards };
}

// `scoreLabel` lives in ./dashboard-shared (the dimension bars share it; importing
// it from here would cycle through ./dimension-headline) - re-exported for callers.
export { liftLabel, scoreLabel };

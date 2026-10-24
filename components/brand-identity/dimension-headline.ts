/**
 * The one-sentence headline that sits above each "What's working by dimension"
 * chart, plus the metric accessors and thin-sample floor it shares with the
 * bars themselves.
 *
 * The default metric is the median composite win score (0..100, the same
 * `computeWinScore` that ranks the leaderboard and plots the winners matrix),
 * not win rate: `isWinner` is longevity-only, so a 3-of-3 label read as 100%
 * and replication never counted.
 *
 * The sentence is templated from the SAME rows, the SAME metric and the SAME
 * `MIN_SAMPLE` floor the chart draws, so it can never narrate a leader the bars
 * don't show. Every claim is honest by construction:
 * - a dimension whose leader scores 0 says so instead of ranking a field of zeroes
 * - an exact tie at the top is named as a tie, never as a single leader
 * - a rounding tie (58.4 vs 57.6 both render "58") drops the comparison clause
 *   rather than printing "58 vs 58"
 * - a catch-all bucket ('other' / 'none') on top is reported as ads OUTSIDE the
 *   named labels, with the leading named label called out separately - it is
 *   not a tactic anyone chose, so it must not read as one worth copying.
 *
 * No JSX - pure string templating over the breakdown rows, so it stays cheap to
 * test the way `winners-matrix.ts` insight copy is.
 */

import type { useTranslations } from 'next-intl';
import type { AnalysisDimension, DimensionBreakdownRow } from '@/lib/brand-identity/types';
import { formatPct, formatReach, labelText, scoreLabel } from './dashboard-shared';

export type DimensionHeadlineTranslator = ReturnType<
  typeof useTranslations<'BrandIdentity.dimensionHeadline'>
>;

/**
 * Non-English rendering of the headline: the `BrandIdentity.dimensionHeadline`
 * translator plus locale-aware label/number formatters. Omitted (English), the
 * legacy English templates below run byte-identically.
 */
export interface DimensionHeadlineI18n {
  t: DimensionHeadlineTranslator;
  label: (_value: string) => string;
  reach: (_value: number) => string;
  pct: (_fraction: number) => string;
}

export type DimensionMetricKey = 'win_score' | 'median_longevity' | 'avg_reach' | 'volume';

/**
 * Below this ad count a label's metric is too thin to trust, so the chart shows
 * "Not enough data" instead of a bar (a "100% from 1 ad" is noise, not signal)
 * and the headline refuses to name it as a leader.
 */
export const MIN_SAMPLE = 3;

export function metricValue(row: DimensionBreakdownRow, metric: DimensionMetricKey): number {
  switch (metric) {
    case 'win_score':
      return row.medianWinScore;
    case 'median_longevity':
      return row.medianLongevity;
    case 'avg_reach':
      return row.avgReach ?? 0;
    case 'volume':
      return row.totalCount;
  }
}

export function metricDisplay(row: DimensionBreakdownRow, metric: DimensionMetricKey): string {
  switch (metric) {
    case 'win_score':
      return scoreLabel(row.medianWinScore);
    case 'median_longevity':
      return `${row.medianLongevity}d`;
    case 'avg_reach':
      return row.avgReach != null ? formatReach(row.avgReach) : '-';
    case 'volume':
      return String(row.totalCount);
  }
}

/** How each metric is named mid-sentence ("tied at the top on run length"). */
const METRIC_NOUNS: Record<DimensionMetricKey, string> = {
  win_score: 'win score',
  median_longevity: 'run length',
  avg_reach: 'average EU reach',
  volume: 'volume',
};

/** Singular/plural nouns for each dimension, matching the tab labels. */
const DIMENSION_NOUNS: Record<AnalysisDimension, { one: string; many: string }> = {
  format: { one: 'format', many: 'formats' },
  hook_archetype: { one: 'hook', many: 'hooks' },
  offer_type: { one: 'offer', many: 'offers' },
  angle: { one: 'angle', many: 'angles' },
  angle_universal: { one: 'angle', many: 'angles' },
  persona: { one: 'persona', many: 'personas' },
  funnel_stage: { one: 'funnel stage', many: 'funnel stages' },
  style: { one: 'style', many: 'styles' },
  aspect_ratio: { one: 'aspect ratio', many: 'aspect ratios' },
  tone: { one: 'tone', many: 'tones' },
  setting: { one: 'setting', many: 'settings' },
  pacing: { one: 'pacing style', many: 'pacing styles' },
  duration_bucket: { one: 'duration', many: 'durations' },
};

const FALLBACK_NOUN = { one: 'tactic', many: 'tactics' };

function nounsFor(dimension: AnalysisDimension | undefined) {
  return (dimension && DIMENSION_NOUNS[dimension]) ?? FALLBACK_NOUN;
}

/**
 * Taxonomy buckets that mean "no label applied" rather than a tactic someone
 * chose: the labeler's catch-all `other` and the `none` bucket NULL offers land
 * in. Naming one of these as the winning tactic would be unactionable.
 */
const CATCH_ALL_LABELS = new Set(['other', 'none', 'unknown']);

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One sentence describing what the currently plotted metric says about this
 * dimension, or null when there is nothing at all to describe (the chart
 * already renders its own "No labeled ads yet." in that case).
 */
export function dimensionHeadline({
  rows,
  metric,
  dimension,
  i18n,
}: {
  rows: DimensionBreakdownRow[];
  metric: DimensionMetricKey;
  dimension: AnalysisDimension | undefined;
  i18n?: DimensionHeadlineI18n;
}): string | null {
  if (rows.length === 0) return null;
  if (i18n) return localizedHeadline({ rows, metric, dimension, i18n });

  const noun = nounsFor(dimension);
  const metricNoun = METRIC_NOUNS[metric];
  const total = rows.reduce((sum, row) => sum + row.totalCount, 0);

  // Same floor the bars use: a label under MIN_SAMPLE draws no bar, so it can
  // never be the headline's leader either.
  const ranked = rows
    .filter((row) => row.totalCount >= MIN_SAMPLE)
    .sort((a, b) => metricValue(b, metric) - metricValue(a, metric));

  if (ranked.length === 0) {
    return (
      `Not enough labeled ads to call a leading ${noun.one} yet - ` +
      `every one here has fewer than ${MIN_SAMPLE}.`
    );
  }

  const leader = ranked[0];
  const leaderValue = metricValue(leader, metric);
  const leaderLabel = labelText(leader.label);

  // Metric-specific "no signal at all" states, checked before any ranking copy
  // so a field of zeroes never reads as a winner.
  // Judged on the rendered integer, so a 0.4 median never reads as "scores
  // highest - a median win score of 0".
  if (metric === 'win_score' && scoreLabel(leader.medianWinScore) === '0') {
    return `No ${noun.one} here has a win score above 0 yet.`;
  }
  if (metric === 'median_longevity' && leaderValue === 0) {
    return `Nothing here has been live long enough to separate these ${noun.many} on run length yet.`;
  }
  if (metric === 'avg_reach' && leader.avgReach == null) {
    return `EU reach is not reported for these ads, so it cannot rank the ${noun.many} yet.`;
  }

  const namedLeader = ranked.find((row) => !CATCH_ALL_LABELS.has(row.label));

  // A catch-all bucket on top is a labeling gap, not a tactic - report it as
  // such and hand the ranking to the leading NAMED label.
  if (CATCH_ALL_LABELS.has(leader.label)) {
    // "with 48" for a raw ad count, "at 58" for a score or "at 12d" for days.
    const preposition = metric === 'volume' ? 'with' : 'at';
    const namedClause = namedLeader
      ? ` - ${labelText(namedLeader.label)} leads the named ones ` +
        `${preposition} ${metricDisplay(namedLeader, metric)}.`
      : '.';
    if (metric === 'volume') {
      return (
        `The biggest bucket is ads outside the named ${noun.many} ` +
        `(${leader.totalCount} of ${total})${namedClause}`
      );
    }
    return (
      `Ads outside the named ${noun.many} lead on ${metricNoun} ` +
      `(${metricDisplay(leader, metric)})${namedClause}`
    );
  }

  const tied = ranked.filter((row) => metricValue(row, metric) === leaderValue);
  if (tied.length > 1) {
    const each = `${metricDisplay(leader, metric)} each`;
    if (tied.length === 2) {
      return (
        `${cap(leaderLabel)} and ${labelText(tied[1].label)} are tied at the top on ` +
        `${metricNoun} - ${each}.`
      );
    }
    return `${tied.length} ${noun.many} are tied at the top on ${metricNoun} - ${each}.`;
  }

  const runner = ranked[1];
  // Only compare against the runner-up when the two render differently -
  // rounding can collapse 58.4 and 57.6 to the same "58".
  const comparable =
    runner && metricDisplay(runner, metric) !== metricDisplay(leader, metric);
  const runnerLabel = runner ? labelText(runner.label) : '';

  switch (metric) {
    case 'win_score':
      return (
        `${cap(leaderLabel)} scores highest - a median win score of ` +
        `${scoreLabel(leader.medianWinScore)} across its ${leader.totalCount} ads` +
        (comparable ? `, vs ${scoreLabel(runner.medianWinScore)} for ${runnerLabel}.` : '.')
      );
    case 'median_longevity':
      return (
        `${cap(leaderLabel)} runs longest - a median of ${leader.medianLongevity} days live` +
        (comparable ? `, vs ${runner.medianLongevity} for ${runnerLabel}.` : '.')
      );
    case 'avg_reach':
      return (
        `${cap(leaderLabel)} reaches furthest - ${formatReach(leader.avgReach!)} average ` +
        `EU reach per ad` +
        (comparable && runner.avgReach != null
          ? `, vs ${formatReach(runner.avgReach)} for ${runnerLabel}.`
          : '.')
      );
    case 'volume':
      return (
        `${cap(leaderLabel)} is the most-used ${noun.one} - ${leader.totalCount} of ` +
        `${total} labeled ads (${formatPct(leader.totalCount / total)}).`
      );
  }
}

/** Locale-aware `metricDisplay` for the translated headline. */
function localizedMetricDisplay(
  row: DimensionBreakdownRow,
  metric: DimensionMetricKey,
  i18n: DimensionHeadlineI18n,
): string {
  switch (metric) {
    case 'win_score':
      return scoreLabel(row.medianWinScore);
    case 'median_longevity':
      return i18n.t('days', { days: row.medianLongevity });
    case 'avg_reach':
      return row.avgReach != null ? i18n.reach(row.avgReach) : '-';
    case 'volume':
      return String(row.totalCount);
  }
}

/**
 * The translated twin of the English templates above: identical branch logic
 * (same floor, same zero/tie/catch-all handling); the dimension is named by its
 * category label so no language needs noun agreement with a placeholder.
 */
function localizedHeadline({
  rows,
  metric,
  dimension,
  i18n,
}: {
  rows: DimensionBreakdownRow[];
  metric: DimensionMetricKey;
  dimension: AnalysisDimension | undefined;
  i18n: DimensionHeadlineI18n;
}): string {
  const { t } = i18n;
  const dimensionName = t(`dimensions.${dimension ?? 'fallback'}`);
  const metricName = t(`metrics.${metric}`);
  const display = (row: DimensionBreakdownRow) => localizedMetricDisplay(row, metric, i18n);
  const total = rows.reduce((sum, row) => sum + row.totalCount, 0);
  const ranked = rows
    .filter((row) => row.totalCount >= MIN_SAMPLE)
    .sort((a, b) => metricValue(b, metric) - metricValue(a, metric));

  if (ranked.length === 0) {
    return t('notEnough', { dimension: dimensionName, min: MIN_SAMPLE });
  }

  const leader = ranked[0];
  const leaderValue = metricValue(leader, metric);
  const leaderLabel = i18n.label(leader.label);

  if (metric === 'win_score' && scoreLabel(leader.medianWinScore) === '0') {
    return t('noWinScore', { dimension: dimensionName });
  }
  if (metric === 'median_longevity' && leaderValue === 0) {
    return t('noLongevity', { dimension: dimensionName });
  }
  if (metric === 'avg_reach' && leader.avgReach == null) {
    return t('noReach', { dimension: dimensionName });
  }

  const namedLeader = ranked.find((row) => !CATCH_ALL_LABELS.has(row.label));
  if (CATCH_ALL_LABELS.has(leader.label)) {
    if (metric === 'volume') {
      return namedLeader
        ? t('catchAllVolumeNamed', {
            dimension: dimensionName,
            count: leader.totalCount,
            total,
            named: i18n.label(namedLeader.label),
            value: display(namedLeader),
          })
        : t('catchAllVolume', { dimension: dimensionName, count: leader.totalCount, total });
    }
    return namedLeader
      ? t('catchAllMetricNamed', {
          dimension: dimensionName,
          metric: metricName,
          leaderValue: display(leader),
          named: i18n.label(namedLeader.label),
          value: display(namedLeader),
        })
      : t('catchAllMetric', {
          dimension: dimensionName,
          metric: metricName,
          leaderValue: display(leader),
        });
  }

  const tied = ranked.filter((row) => metricValue(row, metric) === leaderValue);
  if (tied.length > 1) {
    if (tied.length === 2) {
      return t('tiedTwo', {
        a: leaderLabel,
        b: i18n.label(tied[1].label),
        metric: metricName,
        value: display(leader),
      });
    }
    return t('tiedMany', {
      count: tied.length,
      dimension: dimensionName,
      metric: metricName,
      value: display(leader),
    });
  }

  const runner = ranked[1];
  const comparable = runner && display(runner) !== display(leader);
  const runnerLabel = runner ? i18n.label(runner.label) : '';

  switch (metric) {
    case 'win_score':
      return comparable
        ? t('winScoreVs', {
            label: leaderLabel,
            score: scoreLabel(leader.medianWinScore),
            count: leader.totalCount,
            runnerScore: scoreLabel(runner.medianWinScore),
            runner: runnerLabel,
          })
        : t('winScore', {
            label: leaderLabel,
            score: scoreLabel(leader.medianWinScore),
            count: leader.totalCount,
          });
    case 'median_longevity':
      return comparable
        ? t('longevityVs', {
            label: leaderLabel,
            days: leader.medianLongevity,
            runnerDays: runner.medianLongevity,
            runner: runnerLabel,
          })
        : t('longevity', { label: leaderLabel, days: leader.medianLongevity });
    case 'avg_reach':
      return comparable && runner.avgReach != null
        ? t('reachVs', {
            label: leaderLabel,
            reach: i18n.reach(leader.avgReach!),
            runnerReach: i18n.reach(runner.avgReach),
            runner: runnerLabel,
          })
        : t('reach', { label: leaderLabel, reach: i18n.reach(leader.avgReach!) });
    case 'volume':
      return t('volume', {
        label: leaderLabel,
        count: leader.totalCount,
        total,
        pct: i18n.pct(leader.totalCount / total),
      });
  }
}

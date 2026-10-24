'use client';

import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TOOLTIP_CONTENT_STYLE } from '@/components/dashboard/charts/constants';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type {
  AnalysisDimension,
  DimensionBreakdownRow,
  DimensionOverIndex,
  MediaQuadrants,
  OverIndexDimension,
} from '@/lib/brand-identity/types';
import { MediaBucketTabs } from './MediaBucketTabs';
import {
  SectionHeader,
  scoreLabel,
  useBrandIdentityNumbers,
} from './dashboard-shared';
import { useTaxonomyLabels } from './i18n/taxonomy-labels';
import { BI_TYPE } from './typography';
import {
  MIN_SAMPLE,
  dimensionHeadline,
  metricDisplay,
  metricValue,
  type DimensionMetricKey,
} from './dimension-headline';

// Same tab set as the "Winners vs the rest" matrix, so the two panels slice the
// scope identically - only the rendering differs (bars here, quadrants there).
// `angle` is the industry-specific angle vocabulary; `angle_universal` stays out
// of both panels for the reasons documented in WinnersVsRestPanel.
const DIMENSION_TABS: Array<{
  key: OverIndexDimension;
  labelKey: 'format' | 'hook' | 'offer' | 'angle';
}> = [
  { key: 'format', labelKey: 'format' },
  { key: 'hook_archetype', labelKey: 'hook' },
  { key: 'offer_type', labelKey: 'offer' },
  { key: 'angle', labelKey: 'angle' },
];

// Metric accessors, the thin-sample floor and the headline copy all live in
// ./dimension-headline so the sentence above each chart is templated from
// exactly what the bars below it draw.
type MetricKey = DimensionMetricKey;

const METRICS: Array<{
  key: MetricKey;
  labelKey: 'winScore' | 'medianDays' | 'avgReach' | 'adVolume';
  color: string;
}> = [
  { key: 'win_score', labelKey: 'winScore', color: 'var(--chart-3)' },
  { key: 'median_longevity', labelKey: 'medianDays', color: 'var(--chart-4)' },
  { key: 'avg_reach', labelKey: 'avgReach', color: 'var(--chart-1)' },
  { key: 'volume', labelKey: 'adVolume', color: 'var(--chart-2)' },
];

/** Props recharts hands a custom LabelList `content` renderer. */
type BarLabelProps = {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: number | string;
  index?: number;
};

function MetricToggle({
  metric,
  onChange,
}: {
  metric: MetricKey;
  onChange: (_m: MetricKey) => void;
}) {
  const t = useTranslations('BrandIdentity.dimensionPanel.metrics');
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
      {METRICS.map((m) => (
        <button
          key={m.key}
          type="button"
          aria-pressed={metric === m.key}
          onClick={() => onChange(m.key)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            metric === m.key
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t(m.labelKey)}
        </button>
      ))}
    </div>
  );
}

function CategoryTick({
  x,
  y,
  payload,
  countMap,
  capitalize = true,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
  countMap?: Map<string, number>;
  /** English labels are lower-case and rely on CSS capitalization. */
  capitalize?: boolean;
}) {
  const label = payload?.value ?? '';
  const count = countMap?.get(label);
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <text x={-8} y={0} dy={4} textAnchor="end" className="fill-foreground text-xs">
        <tspan style={capitalize ? { textTransform: 'capitalize' } : undefined}>
          {label}
        </tspan>
        {count != null && (
          <tspan dx={6} className="fill-muted-foreground">
            ·{count}
          </tspan>
        )}
      </text>
    </g>
  );
}

function DimensionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: { label: string; row: DimensionBreakdownRow } }>;
}) {
  const t = useTranslations('BrandIdentity.dimensionPanel.tooltip');
  const tx = useTaxonomyLabels();
  const numbers = useBrandIdentityNumbers();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const row = point.row;
  const stats: Array<[string, string]> = [
    [t('ads'), String(row.totalCount)],
    [t('winScore'), scoreLabel(row.medianWinScore)],
    [t('provenWinners'), t('provenWinnersValue', { winners: row.winnerCount, total: row.totalCount })],
    [t('medianDays'), t('days', { days: row.medianLongevity })],
    [t('avgEuReach'), row.avgReach != null ? numbers.reach(row.avgReach) : '-'],
    [t('active'), numbers.pct(row.activeShare)],
  ];
  return (
    <div style={TOOLTIP_CONTENT_STYLE} className="text-xs">
      <p className={cn('font-medium', tx.capitalizeClass)}>{point.label}</p>
      <div className="mt-1 space-y-0.5">
        {stats.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-6">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-medium tabular-nums">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DimensionBarChart({
  rows,
  metric,
  dimension,
}: {
  rows: DimensionBreakdownRow[];
  metric: MetricKey;
  /** Which facet these rows describe - names the dimension in the headline. */
  dimension: AnalysisDimension | undefined;
}) {
  const t = useTranslations('BrandIdentity.dimensionPanel');
  const tHeadline = useTranslations('BrandIdentity.dimensionHeadline');
  const tx = useTaxonomyLabels();
  const numbers = useBrandIdentityNumbers();
  if (rows.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">{t('noLabeledAds')}</p>;
  }

  const headline = dimensionHeadline({
    rows,
    metric,
    dimension,
    i18n: tx.isEnglish
      ? undefined
      : { t: tHeadline, label: tx.label, reach: numbers.reach, pct: numbers.pct },
  });
  const color = METRICS.find((m) => m.key === metric)!.color;
  const data = rows
    .map((row) => {
      // Thin samples render no bar (value 0 collapses it and sorts it to the
      // bottom) and a "Not enough data" label in place of the metric.
      const tooThin = row.totalCount < MIN_SAMPLE;
      return {
        label: tx.label(row.label),
        value: tooThin ? 0 : metricValue(row, metric),
        display: tooThin
          ? t('notEnoughData')
          : metric === 'median_longevity' && !tx.isEnglish
            ? tHeadline('days', { days: row.medianLongevity })
            : metric === 'avg_reach' && !tx.isEnglish && row.avgReach != null
              ? numbers.reach(row.avgReach)
              : metricDisplay(row, metric),
        tooThin,
        row,
      };
    })
    .sort((a, b) => b.value - a.value);

  const maxValue = Math.max(...data.map((d) => d.value), 1);
  const countMap = new Map(data.map((d) => [d.label, d.row.totalCount]));
  const height = Math.max(180, data.length * 44);

  return (
    <div className="w-full">
      {/* heroClaim, not body: this is the chart's headline, so it sizes one
          notch under the section's panelTitle instead of reading as caption. */}
      {headline && (
        <p className={cn(BI_TYPE.heroClaim, 'max-w-3xl px-2 pt-1 text-foreground')}>
          {headline}
        </p>
      )}
      <div style={{ height }} className="mt-3 w-full px-2 pb-3">
        <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 8, right: 60, bottom: 8, left: 8 }}
        >
          <XAxis type="number" hide domain={[0, maxValue * 1.18]} />
          <YAxis
            type="category"
            dataKey="label"
            width={164}
            tickLine={false}
            axisLine={false}
            tick={<CategoryTick countMap={countMap} capitalize={tx.isEnglish} />}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
            content={<DimensionTooltip />}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={20} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.label} fill={color} />
            ))}
            <LabelList
              dataKey="display"
              content={(props: BarLabelProps) => {
                const index = props.index ?? 0;
                const tooThin = data[index]?.tooThin;
                const x = Number(props.x ?? 0);
                const y = Number(props.y ?? 0);
                const width = Number(props.width ?? 0);
                const barHeight = Number(props.height ?? 0);
                return (
                  <text
                    x={x + width + 8}
                    y={y + barHeight / 2}
                    dominantBaseline="central"
                    className={cn(
                      'text-xs',
                      tooThin
                        ? 'fill-muted-foreground italic'
                        : 'fill-foreground font-medium'
                    )}
                  >
                    {props.value}
                  </text>
                );
              }}
            />
          </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * An over-index row carries every breakdown number (including the reach mean and
 * the median win score, both computed in `buildOverIndexBy`) - so the per-media
 * visual dimensions (which have no `breakdowns` entry) render the same four
 * metrics without a second server-side grouping pass.
 */
function toBreakdownRows(dimension: DimensionOverIndex | undefined) {
  return (dimension?.rows ?? []).map(
    (row): DimensionBreakdownRow => ({
      label: row.label,
      totalCount: row.totalCount,
      winnerCount: row.winnerCount,
      winRate: row.totalCount ? row.winnerCount / row.totalCount : 0,
      medianLongevity: row.medianLongevity,
      avgReach: row.avgReach,
      activeShare: row.activeShare,
      medianWinScore: row.medianWinScore,
    })
  );
}

/**
 * Per-dimension performance across the same facets as the winners-vs-rest matrix
 * (format / hook / offer / angle, plus the per-media image and video visual
 * dimensions) - which labels score highest on the median composite win score
 * (longevity + replication (+ EU reach), the leaderboard's score) and survive
 * longest. A horizontal bar chart per dimension, each headed by a one-sentence
 * read of what the plotted metric says about that facet (`dimension-headline`);
 * the metric toggle switches both the bars and the sentence. Thin samples
 * (< 3 ads) show "Not enough data" instead of a bar so a 2-ad label's score
 * can't read as a real signal - and can't be named the leader in the headline.
 *
 * `surface` picks the chrome: `card` is the app-wide frost section card (the
 * classic overview), `flat` drops it for compositions that carry no card
 * background of their own (the Signal overview).
 */
export function DimensionPerformancePanel({
  breakdowns,
  mediaQuadrants,
  surface = 'card',
}: {
  breakdowns: Record<OverIndexDimension, DimensionBreakdownRow[]>;
  mediaQuadrants: MediaQuadrants;
  surface?: 'card' | 'flat';
}) {
  const [metric, setMetric] = useState<MetricKey>('win_score');
  const t = useTranslations('BrandIdentity.dimensionPanel');

  const tabs = (
    <Tabs defaultValue="format" className="w-full">
      <TabsList className={cn(surface === 'card' && 'm-3 mb-0')}>
        {DIMENSION_TABS.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key}>
            {t(`tabs.${tab.labelKey}`)}
          </TabsTrigger>
        ))}
        <TabsTrigger value="image">{t('tabs.images')}</TabsTrigger>
        <TabsTrigger value="video">{t('tabs.videos')}</TabsTrigger>
      </TabsList>
      {DIMENSION_TABS.map((tab) => (
        <TabsContent key={tab.key} value={tab.key} className="mt-2">
          <DimensionBarChart
            rows={breakdowns[tab.key]}
            metric={metric}
            dimension={tab.key}
          />
        </TabsContent>
      ))}
      {(['image', 'video'] as const).map((bucket) => (
        <TabsContent
          key={bucket}
          value={bucket}
          className={cn('mt-4', surface === 'card' && 'px-3 pb-3')}
        >
          <MediaBucketTabs
            group={mediaQuadrants[bucket]}
            bucket={bucket}
            contentClassName="mt-2"
            renderDimension={(dimension) => (
              // A missing dimension yields zero rows, so the chart's own empty
              // state renders and the undefined noun is never read.
              <DimensionBarChart
                rows={toBreakdownRows(dimension)}
                metric={metric}
                dimension={dimension?.dimension}
              />
            )}
          />
        </TabsContent>
      ))}
    </Tabs>
  );

  return (
    <section className="space-y-3">
      <SectionHeader
        icon={<BarChart3 className="h-5 w-5" />}
        title={t('title')}
        action={<MetricToggle metric={metric} onChange={setMetric} />}
      />
      {surface === 'card' ? (
        <Card className="border-neutral-200/80 p-0 shadow-none">{tabs}</Card>
      ) : (
        tabs
      )}
    </section>
  );
}

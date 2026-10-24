'use client';

import { useEffect, useRef, useState } from 'react';
import { type LucideIcon, Sparkles, Zap } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { DimensionOverIndex } from '@/lib/brand-identity/types';
import { PerformanceMatrix } from './PerformanceMatrix';
import { useFormatLocale } from '@/hooks/useFormatLocale';
import { useLiftLabel, useLocalizedMatrixModel } from './i18n/matrix-copy';
import {
  buildMatrixModel,
  scoreLabel,
  signalQuadrantColor,
  type MatrixColorScheme,
  type Tactic,
} from './winners-matrix';

function IconChip({
  icon: Icon,
  color,
  className,
}: {
  icon: LucideIcon;
  color: string;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-lg border', className)}
      style={{ color, backgroundColor: `${color}1a`, borderColor: `${color}40` }}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

/**
 * Fixed-width ranking label that clips overflowing text with an ellipsis but
 * reveals the full line in a tooltip on hover. The tooltip only renders when the
 * text is actually truncated (measured against the box), so short labels stay
 * tooltip-free.
 */
function TruncatedLabel({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  // English labels are lower-case and rely on CSS capitalization.
  const capitalize = useLocale() === 'en' ? 'capitalize' : '';
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          ref={ref}
          className={cn('w-24 shrink-0 truncate text-xs font-medium', capitalize)}
        >
          {text}
        </span>
      </TooltipTrigger>
      {truncated && <TooltipContent className={capitalize}>{text}</TooltipContent>}
    </Tooltip>
  );
}

function RankingCard({
  title,
  subtitle,
  valueHeader,
  valueHeader2,
  items,
  displayOf,
  displayOf2,
  barOf,
  barMax,
  colorScheme,
}: {
  title: string;
  subtitle: string;
  valueHeader: string;
  /** When set, a second right-aligned value column is rendered (e.g. over-index). */
  valueHeader2?: string;
  items: Tactic[];
  displayOf: (_t: Tactic) => string;
  displayOf2?: (_t: Tactic) => string;
  barOf?: (_t: Tactic) => number;
  barMax?: number;
  colorScheme: MatrixColorScheme;
}) {
  const signal = colorScheme === 'signal';
  const t = useTranslations('BrandIdentity.matrixView');
  return (
    <Card variant="plain" className="border-neutral-200/80 p-4 shadow-none">
      <div className="mb-3 flex items-end justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">{title}</h4>
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex shrink-0 gap-3 text-[11px] text-muted-foreground">
          <span className="w-12 text-right">{valueHeader}</span>
          {valueHeader2 && <span className="w-12 text-right">{valueHeader2}</span>}
        </div>
      </div>
      <div className="space-y-2.5">
        {/* Defensive: buildMatrixModel returns null before this can be empty
            (sub-MIN_SAMPLE tactics are dropped up front, 2026-09-25). */}
        {items.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('notEnoughToRank')}</p>
        )}
        {items.map((tactic) => {
          const pct =
            barOf && barMax && barMax > 0
              ? Math.min(100, Math.max(3, (barOf(tactic) / barMax) * 100))
              : null;
          // Signal reserves magenta for winners (power quadrant); everything
          // else recedes to neutral slate. Category keeps the per-tactic colour.
          const accent = signal ? signalQuadrantColor(tactic.quadrant) : tactic.color;
          const isWinner = signal && tactic.quadrant === 'power';
          return (
            <div key={`${tactic.dimension}:${tactic.label}`} className="flex items-center gap-2">
              <IconChip icon={tactic.icon} color={accent} className="h-6 w-6 [&_svg]:h-3.5 [&_svg]:w-3.5" />
              <TruncatedLabel text={tactic.displayLabel} />
              {pct != null && (
                <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: `${pct}%`, backgroundColor: accent }}
                  />
                </div>
              )}
              <span
                className={cn(
                  'shrink-0 text-right text-xs font-semibold tabular-nums',
                  pct != null ? 'w-12' : displayOf2 ? 'ml-auto w-12' : 'ml-auto',
                  isWinner && 'text-brand-primary'
                )}
              >
                {displayOf(tactic)}
              </span>
              {displayOf2 && (
                <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">
                  {displayOf2(tactic)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function KeyTakeaway({ text }: { text: string }) {
  const t = useTranslations('BrandIdentity.matrixView');
  return (
    <Card variant="plain" className="border-brand-primary/20 bg-brand-primary/5 p-4 shadow-none">
      <div className="flex gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-primary/15 text-brand-primary">
          <Zap className="h-4 w-4" />
        </span>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('keyTakeaway')}
          </p>
          <p className="mt-0.5 text-sm leading-snug">{text}</p>
        </div>
      </div>
    </Card>
  );
}


/**
 * The per-dimension performance matrix view: a four-quadrant over-index ×
 * median win score scatter (or the provisional delivery-days × volume
 * fallback) flanked by a key takeaway and ranking cards. Shared by the main
 * winners-vs-rest panel and the per-media (image/video) quadrants panel - both
 * pass a single `DimensionOverIndex` and get identical, dimension-agnostic
 * rendering. Handles
 * the `buildMatrixModel` null (too few tactics) and provisional/emerging states
 * internally so callers never duplicate that logic.
 */
export function DimensionView({
  dimension,
  colorScheme = 'category',
}: {
  dimension: DimensionOverIndex;
  colorScheme?: MatrixColorScheme;
}) {
  const t = useTranslations('BrandIdentity.matrixView');
  const tMatrix = useTranslations('BrandIdentity.matrix');
  const formatLocale = useFormatLocale();
  const liftLabel = useLiftLabel();
  const model = useLocalizedMatrixModel(buildMatrixModel(dimension));
  if (!model) {
    return (
      <p className="p-6 text-sm text-muted-foreground">{t('notEnoughLabeled')}</p>
    );
  }
  /** Days label for the provisional ranking, e.g. "42d". */
  const daysLabel = (days: number) => tMatrix('days', { days: Math.round(days) });
  const volumeLabel = (volume: number) => volume.toLocaleString(formatLocale);

  const provisional = model.mode === 'provisional';

  return (
    <div className="space-y-4">
      {provisional && model.provisionalNote && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
            <Sparkles className="h-3 w-3" />
            {t('emergingSignal')}
          </span>
          <span className="text-xs text-muted-foreground">{model.provisionalNote}</span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col lg:col-span-2">
          <PerformanceMatrix model={model} colorScheme={colorScheme} />
        </div>
        <div className="space-y-4">
          <KeyTakeaway text={model.insights.takeaway} />
          {provisional ? (
            <>
              <RankingCard
                colorScheme={colorScheme}
                title={t('rankings.longestDelivering.title')}
                subtitle={t('rankings.longestDelivering.subtitle')}
                valueHeader={t('headers.median')}
                items={model.rankings.topOverIndex}
                displayOf={(tactic) => daysLabel(tactic.medianLongevity)}
                barOf={(tactic) => tactic.medianLongevity}
                barMax={Math.max(...model.rankings.topOverIndex.map((tactic) => tactic.medianLongevity), 1)}
              />
              <RankingCard
                colorScheme={colorScheme}
                title={t('rankings.mostScaled.title')}
                subtitle={t('rankings.mostScaled.subtitle')}
                valueHeader={t('headers.ads')}
                items={model.rankings.topWinRate}
                displayOf={(tactic) => volumeLabel(tactic.volume)}
                barOf={(tactic) => tactic.volume}
                barMax={Math.max(...model.rankings.topWinRate.map((tactic) => tactic.volume), 1)}
              />
              <RankingCard
                colorScheme={colorScheme}
                title={t('rankings.shortestDelivering.title')}
                subtitle={t('rankings.shortestDelivering.subtitle')}
                valueHeader={t('headers.median')}
                valueHeader2={t('headers.ads')}
                items={model.rankings.lowest}
                displayOf={(tactic) => daysLabel(tactic.medianLongevity)}
                displayOf2={(tactic) => volumeLabel(tactic.volume)}
              />
            </>
          ) : (
            <>
              <RankingCard
                colorScheme={colorScheme}
                title={t('rankings.mostUsed.title')}
                subtitle={t('rankings.mostUsed.subtitle')}
                valueHeader={t('headers.usage')}
                items={model.rankings.topOverIndex}
                displayOf={(tactic) => liftLabel(tactic.lift)}
                barOf={(tactic) => tactic.lift}
                barMax={Math.max(...model.rankings.topOverIndex.map((tactic) => tactic.lift), 0.01)}
              />
              <RankingCard
                colorScheme={colorScheme}
                title={t('rankings.highestWinScore.title')}
                subtitle={t('rankings.highestWinScore.subtitle')}
                valueHeader={t('headers.score')}
                items={model.rankings.topWinRate}
                displayOf={(tactic) => scoreLabel(tactic.medianWinScore)}
                barOf={(tactic) => tactic.medianWinScore}
                barMax={Math.max(...model.rankings.topWinRate.map((tactic) => tactic.medianWinScore), 1)}
              />
              <RankingCard
                colorScheme={colorScheme}
                title={t('rankings.lowestPerformers.title')}
                subtitle={t('rankings.lowestPerformers.subtitle')}
                valueHeader={t('headers.score')}
                valueHeader2={t('headers.usage')}
                items={model.rankings.lowest}
                displayOf={(tactic) => scoreLabel(tactic.medianWinScore)}
                displayOf2={(tactic) => liftLabel(tactic.lift)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

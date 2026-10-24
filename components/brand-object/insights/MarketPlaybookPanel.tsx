'use client';

/**
 * Chapter 04 — "What wins in your market". Layer 1's winner-gated,
 * replication-weighted market priors read as a FORMULA: the modal winner of
 * each dimension, chained in the order an ad is actually built (hook → angle
 * → format → offer), with each tile expanding to that dimension's full
 * share-of-proof distribution. Every number and headline is arithmetic over
 * the facts (`marketFormula`) — zero comparison logic against the brand, zero
 * LLM judgment — so the chapter's caption stays literally true. The founder's
 * own claims sit beneath the formula they should be weighed against. Empty
 * stream → dashed unlock CTA. The chapter header (with the
 * competitor-analysis deep-link) is owned by the dashboard.
 */
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { Button } from '@/components/ui/button';
import type { BrandBuildProgress } from '@/hooks/brand-object/useBrandObject';
import {
  INSIGHT_LINKS,
  claimHeadline,
  humanizeTagValue,
  marketFormula,
  type IdentityClaimRow,
  type MarketFormulaSegment,
  type MarketFormulaStep,
  type PriorDimensionGroup,
  type ReportTreatment,
} from '@/lib/brand-object/insights';
import { useLocaleFormatters } from '@/hooks/useLocaleFormatters';
import { EyebrowChip } from '@/components/ui/eyebrow-chip';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';
import { useSectionLabel } from './report-copy';
import { sectionTone } from './section-tone';

/** Disclosure "collapse" glyph (U+2212), not a word. */
const MINUS_SIGN = '−';

/** Prior dimension → `BrandReport.market.dimensions` / `.nouns` key. */
const DIMENSION_KEYS = {
  angle: 'angle',
  hook_archetype: 'hook',
  format: 'format',
  offer_type: 'offer',
} as const satisfies Record<MarketFormulaStep['key'], string>;

/** Localized dimension label ("Hook") and copy-frame noun ("hook"). Also used by the Brand Book. */
export function useDimensionCopy() {
  const tLabel = useTranslations('BrandReport.market.dimensions');
  const tNoun = useTranslations('BrandReport.market.nouns');
  return {
    label: (step: MarketFormulaStep) => tLabel(DIMENSION_KEYS[step.key]),
    noun: (step: MarketFormulaStep) => tNoun(DIMENSION_KEYS[step.key]),
  };
}

/**
 * The tile's deterministic headline: English prints `step.headline` as
 * `marketFormula` wrote it; other locales render its `headlineCopy` twin.
 * Winner names are humanized tag values (data) and pass through unchanged.
 */
export function useFormulaHeadline(): (_step: MarketFormulaStep) => string {
  const t = useTranslations('BrandReport.market.headline');
  const locale = useLocale();
  const dimension = useDimensionCopy();
  return (step) => {
    if (locale === DEFAULT_LOCALE) return step.headline;
    const noun = dimension.noun(step);
    const copy = step.headlineCopy;
    switch (copy.code) {
      case 'none':
        return t('none', { noun });
      case 'tie':
        return t('tie', { count: copy.count, noun, weight: copy.weight });
      case 'pair':
        return t('pair', {
          first: copy.first,
          second: copy.second,
          pct: copy.pct,
          noun,
        });
      case 'majority':
        return t('majority', { name: copy.name, pct: copy.pct, noun });
      case 'carries':
        return t('carries', { name: copy.name, pct: copy.pct, noun });
    }
  };
}

/** Below this share a stacked segment is too narrow to hold its own label —
 * the legend underneath carries it instead. */
const SEGMENT_LABEL_MIN_PCT = 18;

export function MarketPlaybookPanel({
  dimensions,
  identity,
  building,
  competitors,
  treatment = 'classic',
}: {
  dimensions: PriorDimensionGroup[];
  identity: IdentityClaimRow[];
  building: boolean;
  /** Live competitor aggregates (objectStatus.progress.competitors) — lets
   * the empty state distinguish "no competitors tracked" from "ads scraped,
   * distillation pending". */
  competitors?: BrandBuildProgress['competitors'] | null;
  treatment?: ReportTreatment;
}) {
  const t = useTranslations('BrandReport.market');
  const formatters = useLocaleFormatters();
  const sectionLabel = useSectionLabel();
  if (dimensions.length === 0) {
    const tagged = competitors?.tagged ?? 0;
    if (tagged > 0) {
      const active = building || (competitors?.syncing ?? 0) > 0;
      return (
        <div className="rounded-xl border border-dashed border-border/70 p-8 text-center">
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            {active && (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            )}
            <span>
              {t.rich('distilling', {
                synced: competitors?.synced ?? 0,
                tagged,
                b: (chunks) => <b className="text-foreground">{chunks}</b>,
              })}
            </span>
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-dashed border-border/70 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {t('empty')}
          {building && ` ${t('buildRunning')}`}
        </p>
        <Button asChild variant="outline" size="sm" className="mt-3">
          <Link href={INSIGHT_LINKS.market}>{t('trackCompetitors')}</Link>
        </Button>
      </div>
    );
  }

  const steps = marketFormula(dimensions);
  // Freshness is a property of the EVIDENCE, not the render: a prior distilled
  // from competitors that stopped syncing months ago otherwise reads exactly
  // like one distilled today. One panel-level callout, keyed off the oldest
  // stale row (scrape cadence is ~2-weekly — never claim a weekly refresh).
  const staleRows = dimensions
    .flatMap((group) => group.rows)
    .filter((row) => row.evidenceStale && row.evidenceAsOf);
  const oldestStaleAt = staleRows.reduce<string | null>((oldest, row) => {
    const value = row.evidenceAsOf as string;
    return !oldest || Date.parse(value) < Date.parse(oldest) ? value : oldest;
  }, null);

  return (
    <div className="section-frost">
      <div className="space-y-4 p-4 sm:p-5">
        {oldestStaleAt && (
          <div className="flex flex-wrap items-center gap-2">
            <EyebrowChip className="text-amber-600 dark:text-amber-400">
              {t('staleBadge')}
            </EyebrowChip>
            <span className="text-[11px] text-muted-foreground">
              {t('evidenceFrom', {
                date: new Date(oldestStaleAt).toLocaleDateString(
                  formatters.locale,
                  {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    timeZone: 'UTC',
                  },
                ),
              })}
            </span>
          </div>
        )}
        {building && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            {t('refreshing')}
          </p>
        )}

        <p className={cn(BI_TYPE.meta, 'text-muted-foreground')}>
          {t.rich('explainer', {
            b: (chunks) => (
              <b className="font-medium text-foreground">{chunks}</b>
            ),
          })}
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {steps.map((step, index) => (
            <FormulaTile key={step.key} step={step} chained={index > 0} />
          ))}
        </div>

        <div className="space-y-2 border-t border-border/60 pt-4">
          <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
            {t('claimsTitle')}
          </p>
          {identity.length === 0 ? (
            <p
              className={cn(
                BI_TYPE.meta,
                'rounded-lg bg-muted/40 p-3 text-muted-foreground',
              )}
            >
              {t('claimsEmpty')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {identity.map((claim) => {
                const tone = sectionTone(claim.section);
                return (
                  <div
                    key={claim.factId}
                    className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-xs"
                  >
                    <span
                      className={cn(
                        BI_TYPE.eyebrow,
                        'inline-flex rounded-full border px-2 py-0.5',
                        tone.pillClass,
                      )}
                    >
                      {sectionLabel(claim.section)}
                    </span>
                    {treatment === 'distilled' ? (
                      // The full statement rides along as the tooltip — this
                      // rail is a glance-level counterweight to the formula,
                      // so it stays one line per claim with no disclosure.
                      <p
                        className={cn(BI_TYPE.cardTitle, 'break-words')}
                        title={claim.statement}
                      >
                        {claimHeadline(claim.statement)}
                      </p>
                    ) : (
                      <p className="break-words leading-relaxed">
                        {claim.statement}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Chapter 04's headline: the whole market reduced to one line — each
 * dimension's winner in the order an ad is built. It answers the chapter
 * title, so it sits above the provenance caption and the panel. Renders
 * nothing until the distillation has produced priors.
 */
export function MarketFormulaHeadline({
  steps,
}: {
  steps: MarketFormulaStep[];
}) {
  const t = useTranslations('BrandReport.market');
  const dimension = useDimensionCopy();
  if (steps.length === 0) return null;
  return (
    <p
      className={cn(
        BI_TYPE.panelTitle,
        'text-balance leading-snug sm:text-xl',
      )}
    >
      <span className="font-normal text-muted-foreground">
        {t('formulaLead')}{' '}
      </span>
      {steps.map((step, index) => (
        <span key={step.key}>
          {index > 0 && (
            <span className="font-normal text-muted-foreground"> · </span>
          )}
          <b className="font-semibold text-brand-text">
            {step.winnerLabel}
          </b>{' '}
          <span className="font-normal text-muted-foreground">
            {dimension.noun(step)}
          </span>
        </span>
      ))}
    </p>
  );
}

/** One dimension of the formula: its winner up front, its full distribution
 * one disclosure away. */
function FormulaTile({
  step,
  chained,
}: {
  step: MarketFormulaStep;
  chained: boolean;
}) {
  const t = useTranslations('BrandReport.market');
  const dimension = useDimensionCopy();
  const formulaHeadline = useFormulaHeadline();
  const noun = dimension.noun(step);
  const winnerCount = step.winners.length;
  return (
    <div className="relative flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand-soft p-3.5">
      {chained && (
        <span
          aria-hidden="true"
          className="absolute -left-3 top-7 hidden h-5 w-5 items-center justify-center rounded-full bg-brand text-[11px] font-bold leading-none text-brand-ink xl:flex"
        >
          +
        </span>
      )}

      <div className="flex items-start justify-between gap-2">
        <p className={cn(BI_TYPE.eyebrow, 'pt-1.5 text-muted-foreground')}>
          {dimension.label(step)}
        </p>
        <ShareDonut
          pct={step.winnerSharePct}
          label={t('donutAria', { pct: step.winnerSharePct, noun })}
        />
      </div>

      <div className="space-y-0.5">
        <p className={cn(BI_TYPE.heroClaim, 'break-words leading-tight')}>
          {step.winnerLabel}
        </p>
        <p className={cn(BI_TYPE.meta, 'tabular-nums text-muted-foreground')}>
          {t('repConcepts', {
            weight: step.winnerWeight,
            concepts: step.winnerConcepts,
          })}
        </p>
      </div>

      <details className="group mt-auto border-t border-brand/30 pt-2">
        <summary
          className={cn(
            BI_TYPE.meta,
            'inline-flex cursor-pointer list-none items-center gap-1 font-semibold text-brand-text [&::-webkit-details-marker]:hidden',
          )}
        >
          {t('allPatterns', { count: step.segments.length, noun })}
          <span aria-hidden="true" className="group-open:hidden">
            +
          </span>
          <span aria-hidden="true" className="hidden group-open:inline">
            {MINUS_SIGN}
          </span>
        </summary>
        <div className="mt-2 space-y-2">
          <p className={cn(BI_TYPE.meta, 'font-medium')}>
            {formulaHeadline(step)}
          </p>
          <div className="flex h-7 gap-px overflow-hidden rounded-md">
            {step.segments.map((segment, index) => (
              <span
                key={segment.factId}
                className={cn(
                  'flex min-w-0 items-center overflow-hidden px-1.5 text-[11px] font-medium leading-none',
                  segmentTone(segment, index, winnerCount),
                )}
                style={{ width: `${segment.sharePct}%` }}
                title={t('segmentTitle', {
                  name: humanizeTagValue(segment.value),
                  pct: Math.round(segment.sharePct),
                  weight: segment.replicationWeight,
                })}
              >
                {segment.sharePct >= SEGMENT_LABEL_MIN_PCT && (
                  <span className="truncate">
                    {humanizeTagValue(segment.value)}
                  </span>
                )}
              </span>
            ))}
          </div>
          <ul className="space-y-1.5">
            {step.segments.map((segment, index) => (
              <li key={segment.factId} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-1 h-2 w-2 shrink-0 rounded-sm',
                    segmentTone(segment, index, winnerCount),
                  )}
                />
                <span className={cn(BI_TYPE.meta, 'min-w-0 flex-1')}>
                  <span className="break-words font-medium">
                    {humanizeTagValue(segment.value)}
                  </span>
                  <span className="block tabular-nums text-muted-foreground">
                    {t('segmentMeta', {
                      pct: Math.round(segment.sharePct),
                      weight: segment.replicationWeight,
                      concepts: segment.conceptCount,
                    })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

/** Winner solid, runner-up mid, tail faint — rank encoded in weight, not hue. */
function segmentTone(
  segment: MarketFormulaSegment,
  index: number,
  winnerCount: number,
): string {
  if (segment.isWinner) return 'bg-brand text-brand-ink';
  if (index === winnerCount) return 'bg-brand-soft text-foreground';
  return 'bg-brand-soft text-muted-foreground';
}

const DONUT_RADIUS = 19;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

/** The winner's share of its dimension, as a ring — four of these side by side
 * show at a glance which dimensions are settled and which are contested. */
function ShareDonut({ pct, label }: { pct: number; label: string }) {
  const t = useTranslations('BrandReport.market');
  const clamped = Math.max(0, Math.min(100, pct));
  const arc = (clamped / 100) * DONUT_CIRCUMFERENCE;
  return (
    <svg
      viewBox="0 0 48 48"
      className="h-12 w-12 shrink-0"
      role="img"
      aria-label={label}
    >
      <circle
        cx="24"
        cy="24"
        r={DONUT_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        className="text-brand-text"
      />
      <circle
        cx="24"
        cy="24"
        r={DONUT_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        // A round cap on a zero-length arc still paints a dot — a 0% ring must
        // read as empty.
        strokeLinecap={arc > 0 ? 'round' : 'butt'}
        strokeDasharray={`${arc} ${DONUT_CIRCUMFERENCE - arc}`}
        transform="rotate(-90 24 24)"
        className="text-brand-text"
      />
      <text
        x="24"
        y="28"
        textAnchor="middle"
        fill="currentColor"
        className="text-xs font-semibold tabular-nums text-foreground"
      >
        {t('pct', { pct })}
      </text>
    </svg>
  );
}

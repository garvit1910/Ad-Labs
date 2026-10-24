'use client';

/**
 * Chapter "What's working for you" — the org's OWN ad performance per
 * creative label, read like Chapter 04's formula: the spend leader of each
 * label dimension chained in the order an ad is BUILT (hook → angle → format
 * → offer → persona → funnel stage), each tile expanding to its full
 * share-of-spend split, then the hook × angle × format combinations that
 * cleared every gate. ZERO LLM: every number and the headline arrive
 * pre-computed in `OwnPerformanceModel` (`lib/brand-object/own-performance.ts`)
 * and print through the shared formatters, so the Brand Book and the headless
 * PDF spell each figure exactly as this panel does. The dashboard mounts it
 * only when the model is non-empty. REPORT-ONLY — evidence, never actions.
 */
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_LOCALE, toIntlTag } from '@/i18n/config';
import { EyebrowChip } from '@/components/ui/eyebrow-chip';
import { StatusPill } from '@/components/ui/status-pill';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { humanizeTagValue, type ReportTreatment } from '@/lib/brand-object/insights';
import {
  COMBINATION_MIN_ADS,
  COMBINATION_MIN_PURCHASES,
  COMBINATION_MIN_SPEND_SHARE_PCT,
  MIN_PURCHASES_FOR_RETURN,
  type OwnPerformanceDimension,
  type OwnPerformanceModel,
} from '@/lib/brand-object/own-performance';
import {
  formatCtr,
  formatPerformanceMoney,
  formatRoas,
  formatSharePct,
} from '@/lib/brand-object/own-performance-format';
import { cn } from '@/lib/utils';

/** Disclosure "collapse" glyph (U+2212), not a word. */
const MINUS_SIGN = '−';

/**
 * Copy for this chapter. Figures still print through the shared
 * `own-performance-format` helpers (the Brand Book and the headless PDF use
 * the same ones); only the words around them are translated. The model's
 * English `headline` / captions are rebuilt here from the same fields.
 */
const DIMENSION_KEYS = {
  hook_archetype: 'hook',
  angle: 'angle',
  format: 'format',
  offer_type: 'offer',
  persona: 'persona',
  funnel_stage: 'funnelStage',
} as const satisfies Record<OwnPerformanceDimension['dimension'], string>;

/**
 * The shared `own-performance-format` helpers, bound to the user's Intl tag.
 * English passes no locale, so its figures stay byte-identical to the Brand
 * Book and the headless PDF (which keep calling the helpers bare).
 */
export function usePerformanceFormat() {
  const locale = useLocale();
  const tag = locale === DEFAULT_LOCALE ? undefined : toIntlTag(locale);
  return {
    money: (amount: number, currency: string) =>
      tag
        ? formatPerformanceMoney(amount, currency, tag)
        : formatPerformanceMoney(amount, currency),
    roas: (roas: number | null) => formatRoas(roas, tag),
    share: (pct: number) => formatSharePct(pct, tag),
    ctr: (ctr: number | null) => formatCtr(ctr, tag),
  };
}

export function useDimensionCopy() {
  const tLabel = useTranslations('BrandReport.performance.dimensions');
  const tNoun = useTranslations('BrandReport.performance.nouns');
  return {
    label: (dimension: OwnPerformanceDimension) =>
      tLabel(DIMENSION_KEYS[dimension.dimension]),
    noun: (dimension: OwnPerformanceDimension) =>
      tNoun(DIMENSION_KEYS[dimension.dimension]),
  };
}

/** Metric codes are never translated. */
const METRIC_ROAS = 'ROAS';
const METRIC_CPA = 'CPA';
const METRIC_CTR = 'CTR';
const EM_DASH = '—';

/** Below this share a stacked segment is too narrow to hold its own label. */
const SEGMENT_LABEL_MIN_PCT = 18;

/**
 * The chapter's one-line answer: a template the model chose by threshold —
 * the humanized tag value emphasized, never reworded.
 */
export function OwnPerformanceHeadline({ model }: { model: OwnPerformanceModel }) {
  const t = useTranslations('BrandReport.performance');
  const fmt = usePerformanceFormat();
  const dimension = useDimensionCopy();
  const { headline } = model;
  // `performanceHeadline` reads the angle dimension, else the first one.
  const focus =
    model.dimensions.find((entry) => entry.dimension === 'angle') ??
    model.dimensions[0];
  const best = focus?.bestReturn ?? null;
  const tags = {
    muted: (chunks: React.ReactNode) => (
      <span className="font-normal text-muted-foreground">{chunks}</span>
    ),
    b: (chunks: React.ReactNode) => (
      <b className="break-words font-semibold text-brand-text">{chunks}</b>
    ),
  };
  const line =
    headline.kind === 'empty' || !focus
      ? t.rich('headline.empty', tags)
      : headline.kind === 'concentrated' || !best || best.roas == null
        ? t.rich('headline.concentrated', {
            ...tags,
            value: headline.value,
            share: fmt.share(focus.leaderSharePct),
            noun: dimension.noun(focus),
          })
        : t.rich(
            headline.kind === 'best_return_is_leader'
              ? 'headline.bestIsLeader'
              : 'headline.best',
            {
              ...tags,
              value: headline.value,
              noun: dimension.noun(focus),
              roas: fmt.roas(best.roas) ?? '',
              spend: fmt.money(best.spend, model.currency),
            },
          );
  const window = t('window', { days: model.windowDays });
  const coverage =
    model.coverage.totalSpend > 0
      ? t('coverage', {
          share: fmt.share(
            Math.min(
              100,
              (model.coverage.labeledSpend / model.coverage.totalSpend) * 100,
            ),
          ),
          window,
        })
      : t('labeledAdsWindow', { window });
  return (
    <div className="space-y-1">
      <p className={cn(BI_TYPE.panelTitle, 'text-balance leading-snug sm:text-xl')}>
        {line}
      </p>
      <p className={cn(BI_TYPE.meta, 'text-muted-foreground')}>
        {t('coverageLine', { coverage, count: model.labeledAdCount })}
      </p>
    </div>
  );
}

export function OwnPerformancePanel({
  model,
  treatment = 'classic',
}: {
  model: OwnPerformanceModel;
  treatment?: ReportTreatment;
}) {
  const t = useTranslations('BrandReport.performance');
  const pooledBanner = model.scope.pooled
    ? t('pooledBanner', { count: model.scope.brandCount })
    : null;
  return (
    <div className="section-frost" data-treatment={treatment}>
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone="not_set" hideDot>
            {t('platformReported')}
          </StatusPill>
          <EyebrowChip>{t('window', { days: model.windowDays })}</EyebrowChip>
          {model.demo && (
            <EyebrowChip className="text-amber-700 dark:text-amber-300">
              {t('demoData')}
            </EyebrowChip>
          )}
        </div>

        {pooledBanner && (
          <div role="note" className="banner-resume px-3.5 py-2.5">
            <p className={cn(BI_TYPE.meta, 'font-medium text-amber-800 dark:text-amber-200')}>
              {pooledBanner}
            </p>
          </div>
        )}

        <p className={cn(BI_TYPE.meta, 'text-muted-foreground')}>
          {t('basis', {
            currency: model.currency,
            minPurchases: MIN_PURCHASES_FOR_RETURN,
          })}
          {model.currencyNote ? ` ${model.currencyNote}` : ''}
          {model.truncated ? ` ${t('truncated')}` : ''}
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {model.dimensions.map((dimension) => (
            <DimensionTile
              key={dimension.dimension}
              dimension={dimension}
              currency={model.currency}
            />
          ))}
        </div>

        <WinningCombinations model={model} />
      </div>
    </div>
  );
}

/** One label dimension: its spend leader up front, the full split one disclosure away. */
function DimensionTile({
  dimension,
  currency,
}: {
  dimension: OwnPerformanceDimension;
  currency: string;
}) {
  const t = useTranslations('BrandReport.performance');
  const fmt = usePerformanceFormat();
  const copy = useDimensionCopy();
  const noun = copy.noun(dimension);
  const notEnough = t('notEnoughPurchases');
  const best = dimension.bestReturn;
  const leaderCount = dimension.leaders.length;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-brand/30 bg-brand-soft p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
          {copy.label(dimension)}
        </p>
        <span className={cn(BI_TYPE.cardTitle, 'tabular-nums text-brand-text')}>
          {fmt.share(dimension.leaderSharePct)}
        </span>
      </div>

      <div className="space-y-0.5">
        <p className={cn(BI_TYPE.heroClaim, 'break-words leading-tight')}>
          {dimension.leaderLabel}
        </p>
        <p className={cn(BI_TYPE.meta, 'tabular-nums text-muted-foreground')}>
          {t('ofSpend', {
            noun,
            spend: fmt.money(
              dimension.leaders.reduce((sum, row) => sum + row.spend, 0),
              currency,
            ),
          })}
        </p>
        <p className={cn(BI_TYPE.meta, 'break-words text-muted-foreground')}>
          {best && best.roas != null ? (
            t.rich('bestReturn', {
              value: humanizeTagValue(best.value),
              roas: fmt.roas(best.roas) ?? '',
              b: (chunks) => (
                <b className="font-semibold text-foreground">{chunks}</b>
              ),
            })
          ) : (
            t('returnsNotEnough', { label: notEnough })
          )}
        </p>
      </div>

      <details className="group mt-auto border-t border-brand/30 pt-2">
        <summary
          className={cn(
            BI_TYPE.meta,
            'inline-flex cursor-pointer list-none items-center gap-1 font-semibold text-brand-text [&::-webkit-details-marker]:hidden',
          )}
        >
          {t('allValues', { count: dimension.rows.length, noun })}
          <span aria-hidden="true" className="group-open:hidden">
            +
          </span>
          <span aria-hidden="true" className="hidden group-open:inline">
            {MINUS_SIGN}
          </span>
        </summary>
        <div className="mt-2 space-y-2">
          <div className="flex h-7 gap-px overflow-hidden rounded-md">
            {dimension.rows.map((row, index) => (
              <span
                key={row.value}
                className={cn(
                  'flex min-w-0 items-center overflow-hidden px-1.5 text-[11px] font-medium leading-none',
                  segmentTone(index, leaderCount),
                )}
                style={{ width: `${row.spendSharePct}%` }}
                title={t('segmentTitle', {
                  name: humanizeTagValue(row.value),
                  share: fmt.share(row.spendSharePct),
                })}
              >
                {row.spendSharePct >= SEGMENT_LABEL_MIN_PCT && (
                  <span className="truncate">{humanizeTagValue(row.value)}</span>
                )}
              </span>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className={cn(BI_TYPE.meta, 'w-full min-w-[22rem] tabular-nums')}>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">{t('table.value')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('table.ads')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('table.spend')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{METRIC_ROAS}</th>
                  <th className="py-1 pr-2 text-right font-medium">{METRIC_CPA}</th>
                  <th className="py-1 text-right font-medium">{METRIC_CTR}</th>
                </tr>
              </thead>
              <tbody>
                {dimension.rows.map((row) => (
                  <tr key={row.value} className="border-t border-border/50 align-top">
                    <td className="break-words py-1 pr-2 font-medium">
                      {humanizeTagValue(row.value)}
                    </td>
                    <td className="py-1 pr-2 text-right">{row.adCount}</td>
                    <td className="py-1 pr-2 text-right">
                      {fmt.money(row.spend, currency)}
                      <span className="block text-muted-foreground">
                        {fmt.share(row.spendSharePct)}
                      </span>
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {fmt.roas(row.roas) ?? (
                        <span className="text-muted-foreground">{notEnough}</span>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {row.cpa != null ? fmt.money(row.cpa, currency) : EM_DASH}
                    </td>
                    <td className="py-1 text-right">{fmt.ctr(row.ctr) ?? EM_DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </div>
  );
}

/** Leader solid, runner-up mid, tail faint — rank encoded in weight, not hue. */
function segmentTone(index: number, leaderCount: number): string {
  if (index < leaderCount) return 'bg-brand text-brand-ink';
  if (index === leaderCount) return 'bg-brand-soft text-foreground';
  return 'bg-brand-soft text-muted-foreground';
}

function WinningCombinations({ model }: { model: OwnPerformanceModel }) {
  const t = useTranslations('BrandReport.performance');
  const fmt = usePerformanceFormat();
  return (
    <div className="space-y-2 border-t border-border/60 pt-4">
      <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
        {t('combinationsTitle')}
      </p>
      {model.combinations.length === 0 ? (
        <p className={cn(BI_TYPE.meta, 'rounded-lg bg-muted/40 p-3 text-muted-foreground')}>
          {t('combinationsEmpty', {
            ads: COMBINATION_MIN_ADS,
            purchases: COMBINATION_MIN_PURCHASES,
            share: COMBINATION_MIN_SPEND_SHARE_PCT,
          })}
        </p>
      ) : (
        <ol className="space-y-2">
          {model.combinations.map((combination, index) => (
            <li
              key={`${combination.hook}|${combination.angle}|${combination.format}`}
              className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <span className={cn(BI_TYPE.body, 'min-w-0 break-words')}>
                <span className="mr-2 font-semibold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                {t.rich('combination', {
                  hook: humanizeTagValue(combination.hook),
                  angle: humanizeTagValue(combination.angle),
                  format: humanizeTagValue(combination.format),
                  b: (chunks) => <b className="font-semibold">{chunks}</b>,
                })}
              </span>
              <span className={cn(BI_TYPE.meta, 'shrink-0 tabular-nums text-muted-foreground')}>
                {t.rich('combinationMeta', {
                  roas: fmt.roas(combination.roas) ?? '',
                  spend: fmt.money(combination.spend, model.currency),
                  count: combination.adCount,
                  b: (chunks) => (
                    <b className="font-semibold text-brand-text">{chunks}</b>
                  ),
                })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

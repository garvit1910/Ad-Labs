'use client';

/**
 * Locale rendering of the "Winners vs the rest" matrix model.
 *
 * `buildMatrixModel` (pure, English) stays the source of truth: its English
 * strings are what English renders and what its tests pin. For other locales
 * this hook rebuilds every user-visible string - tactic labels, axis labels,
 * ticks, tooltip, caption, quadrant titles, the provisional note and the key
 * takeaway - from the `BrandIdentity.matrix` catalog, using the model's
 * structured `takeawayCopy` / `provisionalReason` and raw numbers. Ranking,
 * layout and quadrant math are untouched.
 */
import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { MatrixModel, MatrixTakeawayCopy } from '../winners-matrix';
import { scoreLabel } from '../dashboard-shared';
import { MIN_SAMPLE } from '../dimension-headline';
import { useTaxonomyLabels } from './taxonomy-labels';

type MatrixTranslator = ReturnType<typeof useTranslations<'BrandIdentity.matrix'>>;

function takeawayText(
  copy: MatrixTakeawayCopy,
  t: MatrixTranslator,
  label: (_v: string) => string,
  lift: (_v: number) => string,
): string {
  switch (copy.kind) {
    case 'provisionalLowSample':
      return t('takeaway.provisionalLowSample', {
        total: copy.total,
        label: label(copy.label),
        days: copy.days,
      });
    case 'provisionalNoWinners':
      return t('takeaway.provisionalNoWinners', { label: label(copy.label), days: copy.days });
    case 'noWinners':
      return t('takeaway.noWinners', { min: copy.min });
    case 'noScore':
      return t('takeaway.noScore', { topLift: label(copy.topLift), lift: lift(copy.lift) });
    case 'tiedTwo':
      return t('takeaway.tiedTwo', {
        topLift: label(copy.topLift),
        lift: lift(copy.lift),
        a: label(copy.a),
        b: label(copy.b),
        score: copy.score,
      });
    case 'tiedMany':
      return t('takeaway.tiedMany', {
        topLift: label(copy.topLift),
        lift: lift(copy.lift),
        count: copy.count,
        score: copy.score,
      });
    case 'leader':
      return t('takeaway.leader', {
        topLift: label(copy.topLift),
        lift: lift(copy.lift),
        label: label(copy.label),
        score: copy.score,
        count: copy.count,
      });
  }
}

/** The model with every rendered string in the active locale (English: unchanged). */
export function useLocalizedMatrixModel(model: MatrixModel | null): MatrixModel | null {
  const t = useTranslations('BrandIdentity.matrix');
  const tx = useTaxonomyLabels();
  const format = useFormatter();

  return useMemo(() => {
    if (!model || tx.isEnglish) return model;
    const lift = (value: number) =>
      t('lift', {
        value: format.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      });
    const days = (value: number) => t('days', { days: Math.round(value) });
    const count = (value: number) => format.number(Math.round(value));
    const [xMin, xMax] = model.xDomain;
    const [yMin, yMax] = model.yDomain;
    const winners = model.mode === 'winners';
    const display: MatrixModel['display'] = winners
      ? {
          xAxisLabel: t('winners.xAxis'),
          yAxisLabel: t('winners.yAxis'),
          xTickLabels: [lift(xMin), lift(model.xMidValue), lift(xMax)],
          yTickLabels: [scoreLabel(yMax), scoreLabel(model.yMidValue), scoreLabel(yMin)],
          tooltip: t('winners.tooltip', { min: MIN_SAMPLE }),
          caption: t('winners.caption'),
          quadrantTitles: {
            power: { title: t('quadrants.power.title'), subtitle: t('quadrants.power.subtitle') },
            common: { title: t('quadrants.common.title'), subtitle: t('quadrants.common.subtitle') },
            gems: { title: t('quadrants.gems.title'), subtitle: t('quadrants.gems.subtitle') },
            under: { title: t('quadrants.under.title'), subtitle: t('quadrants.under.subtitle') },
          },
        }
      : {
          xAxisLabel: t('provisional.xAxis'),
          yAxisLabel: t('provisional.yAxis'),
          xTickLabels: [count(xMin), count(model.xMidValue), count(xMax)],
          yTickLabels: [days(yMax), days(model.yMidValue), days(yMin)],
          tooltip: t('provisional.tooltip'),
          caption: t('provisional.caption'),
          quadrantTitles: {
            power: { title: t('provisionalQuadrants.power.title'), subtitle: t('provisionalQuadrants.power.subtitle') },
            common: { title: t('provisionalQuadrants.common.title'), subtitle: t('provisionalQuadrants.common.subtitle') },
            gems: { title: t('provisionalQuadrants.gems.title'), subtitle: t('provisionalQuadrants.gems.subtitle') },
            under: { title: t('provisionalQuadrants.under.title'), subtitle: t('provisionalQuadrants.under.subtitle') },
          },
        };
    const provisionalNote =
      model.provisionalReason === 'low_sample'
        ? t('provisionalNote.lowSample', { count: model.labeledAds })
        : model.provisionalReason === 'no_winners'
          ? t('provisionalNote.noWinners')
          : null;
    const localize = (tactic: MatrixModel['tactics'][number]) => ({
      ...tactic,
      displayLabel: tx.label(tactic.label),
    });
    const tactics = model.tactics.map(localize);
    return {
      ...model,
      tactics,
      display,
      provisionalNote,
      rankings: {
        topOverIndex: model.rankings.topOverIndex.map(localize),
        topWinRate: model.rankings.topWinRate.map(localize),
        lowest: model.rankings.lowest.map(localize),
      },
      insights: {
        ...model.insights,
        takeaway: takeawayText(model.insights.takeawayCopy, t, tx.label, lift),
      },
    };
  }, [model, t, tx, format]);
}

/** Locale-aware `liftLabel` for ranking cells ('1.5×' in English). */
export function useLiftLabel(): (_lift: number) => string {
  const t = useTranslations('BrandIdentity.matrix');
  const tx = useTaxonomyLabels();
  const format = useFormatter();
  return useMemo(
    () => (value: number) =>
      tx.isEnglish
        ? `${value.toFixed(1)}×`
        : t('lift', {
            value: format.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
          }),
    [t, tx, format],
  );
}

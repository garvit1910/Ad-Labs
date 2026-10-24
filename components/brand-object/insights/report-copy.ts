'use client';

/**
 * Translated labels for the Brand Identity report's enums whose English
 * constants live in shared, non-React modules (`SECTION_TONE`, the VOC kind
 * config, `AWARENESS_STAGE_META`). The English constants stay for their pure
 * helpers and tests; render sites read the catalog through these hooks, each
 * mapping an id to a leaf key through a typed `Record`.
 */
import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AwarenessStage, BrandSection } from '@/lib/brand-object/types';
import type { VocSection } from '@/lib/brand-object/insights';
import {
  OBSERVABLE_AWARENESS_STAGES,
  type AwarenessSpread,
} from './persona-signal';

const SECTION_KEYS = {
  positioning: 'positioning',
  value_prop: 'valueProp',
  usp: 'usp',
  proof_point: 'proofPoint',
  voice: 'voice',
  compliance: 'compliance',
  voc_pain: 'vocPain',
  voc_desire: 'vocDesire',
  voc_objection: 'vocObjection',
  voc_praise: 'vocPraise',
  competitor_intel: 'competitorIntel',
  market_prior: 'marketPrior',
  performance_prior: 'performancePrior',
  persona: 'persona',
} as const satisfies Record<BrandSection, string>;

/** `sectionTone(section).label` in the user's language; an open-string
 * section the list hasn't caught up with renders sentence-cased raw. */
export function useSectionLabel(): (_section: string) => string {
  const t = useTranslations('BrandReport.sections');
  return useCallback(
    (section: string) => {
      const key = SECTION_KEYS[section as BrandSection];
      return key ? t(key) : section.replace(/_/g, ' ');
    },
    [t],
  );
}

const VOC_KIND_KEYS = {
  voc_pain: 'pain',
  voc_desire: 'desire',
  voc_objection: 'objection',
  voc_praise: 'praise',
} as const satisfies Record<VocSection, string>;

/** Plural VOC kind title ("Pains", "Praise"). */
export function useVocKindTitle(): (_section: VocSection) => string {
  const t = useTranslations('BrandReport.vocKinds');
  return useCallback((section: VocSection) => t(VOC_KIND_KEYS[section]), [t]);
}

const STAGE_KEYS = {
  unaware: 'unaware',
  problem_aware: 'problemAware',
  solution_aware: 'solutionAware',
  product_aware: 'productAware',
  most_aware: 'mostAware',
} as const satisfies Record<AwarenessStage, string>;

/** `AWARENESS_STAGE_META` / `UNSTAGED_META` / `AWARENESS_STAGE_JOB` copy. */
export function useAwarenessCopy() {
  const tLabel = useTranslations('BrandReport.awareness.labels');
  const tBlurb = useTranslations('BrandReport.awareness.blurbs');
  const tJob = useTranslations('BrandReport.awareness.jobs');
  const t = useTranslations('BrandReport.awareness');
  const locale = useLocale();
  const label = useCallback(
    (stage: AwarenessStage | 'unstaged') =>
      stage === 'unstaged' ? t('unstagedLabel') : tLabel(STAGE_KEYS[stage]),
    [t, tLabel],
  );
  const blurb = useCallback(
    (stage: AwarenessStage | 'unstaged') =>
      stage === 'unstaged' ? t('unstagedBlurb') : tBlurb(STAGE_KEYS[stage]),
    [t, tBlurb],
  );
  const job = useCallback(
    (stage: AwarenessStage) => tJob(STAGE_KEYS[stage]),
    [tJob],
  );
  /** `awarenessGapNote`, localized — same branches, same thresholds. */
  const gapNote = useCallback(
    (spread: AwarenessSpread) => {
      const parts: string[] = [];
      const occupied =
        OBSERVABLE_AWARENESS_STAGES.length - spread.empty.length;
      // Stage names read lowercase mid-sentence, except in German where the
      // nouns keep their capital.
      const inline = (stage: AwarenessStage) =>
        locale === 'de' ? label(stage) : label(stage).toLocaleLowerCase(locale);
      if (spread.empty.length === 0) {
        parts.push(t('gap.everyStage'));
      } else if (spread.empty.length === 1) {
        parts.push(t('gap.nobodyAtOne', { stage: inline(spread.empty[0]) }));
      } else if (spread.empty.length === 2) {
        parts.push(
          t('gap.nobodyAtTwo', {
            first: inline(spread.empty[0]),
            second: inline(spread.empty[1]),
          }),
        );
      } else {
        parts.push(t('gap.onlySome', { count: occupied }));
      }
      if (spread.unstaged > 0) {
        parts.push(t('gap.unstaged', { count: spread.unstaged }));
      }
      return parts.join(' ');
    },
    [label, locale, t],
  );
  return { label, blurb, job, gapNote };
}

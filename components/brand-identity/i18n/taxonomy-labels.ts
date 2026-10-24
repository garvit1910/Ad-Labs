'use client';

/**
 * Localized labels for the ad-label taxonomy (hooks, angles, personas,
 * formats, offers, funnel stages, tones, styles, settings, pacing, media
 * types) and the industry list, shared by every Competitor Analysis surface.
 *
 * Taxonomy ids stay the labeller's snake_case tokens everywhere else (DB rows,
 * URL filters, LLM prompts, MCP output); only the rendered label goes through
 * the `BrandIdentity.taxonomy` / `BrandIdentity.industries` catalogs, keyed by
 * the id itself. English keeps the legacy formatters byte-identical
 * (`labelText` lower-case + CSS `capitalize`, `getAngleLabel`/
 * `getPersonaLabel` Title Case, `industry.label`). An id the catalog does not
 * hold (a vocabulary token added later) falls back to the English formatter,
 * never a raw key.
 */
import { useMemo } from 'react';
import { useLocale, useTranslations, type Messages } from 'next-intl';
import { getAngleLabel, getPersonaLabel } from '@/lib/brand-identity/industry-taxonomy';
import { getIndustry } from '@/lib/brand-identity/industries';
import { labelText } from '../dashboard-shared';

type TaxonomyToken = keyof Messages['BrandIdentity']['taxonomy'];
type IndustryToken = keyof Messages['BrandIdentity']['industries'];

export interface TaxonomyLabels {
  /** True for English: legacy lower-case labels rely on CSS `capitalize`. */
  readonly isEnglish: boolean;
  /** `'capitalize'` in English (legacy styling), `''` elsewhere (catalog copy is sentence case). */
  readonly capitalizeClass: string;
  /** Any taxonomy token (`labelText` in English). */
  label(_value: string): string;
  /** Angle token, Title Case in English (`getAngleLabel`). */
  angle(_value: string): string;
  /** Persona token, Title Case in English (`getPersonaLabel`). */
  persona(_value: string): string;
  /** Industry key (`industry.label` in English). */
  industry(_key: string): string;
}

export type TaxonomyTranslator = ReturnType<typeof useTranslations<'BrandIdentity.taxonomy'>>;
export type IndustryTranslator = ReturnType<typeof useTranslations<'BrandIdentity.industries'>>;

/** Pure form (tests build the translators with `createTranslator`). */
export function createTaxonomyLabels(
  locale: string,
  t: TaxonomyTranslator,
  tIndustry: IndustryTranslator,
): TaxonomyLabels {
  const isEnglish = locale === 'en';
  const translated = (value: string, english: (_v: string) => string): string => {
    if (isEnglish) return english(value);
    return t.has(value as TaxonomyToken) ? t(value as TaxonomyToken) : english(value);
  };
  return {
    isEnglish,
    capitalizeClass: isEnglish ? 'capitalize' : '',
    label: (value) => translated(value, labelText),
    angle: (value) => translated(value, getAngleLabel),
    persona: (value) => translated(value, getPersonaLabel),
    industry: (key) => {
      const english = getIndustry(key)?.label ?? key;
      if (isEnglish) return english;
      return tIndustry.has(key as IndustryToken) ? tIndustry(key as IndustryToken) : english;
    },
  };
}

export function useTaxonomyLabels(): TaxonomyLabels {
  const locale = useLocale();
  const t = useTranslations('BrandIdentity.taxonomy');
  const tIndustry = useTranslations('BrandIdentity.industries');
  return useMemo(() => createTaxonomyLabels(locale, t, tIndustry), [locale, t, tIndustry]);
}

/**
 * Per-section pill tone for the Brand Identity report. A claim's section is
 * the only thing distinguishing two otherwise identical cards, so the label
 * carries a hue rather than a shared muted grey — a reader scanning a grid can
 * tell a USP from a value prop without reading the pill.
 *
 * The four VOC hues are NOT chosen here: they mirror `VocReportPanel`'s
 * KIND_CONFIG so chapter 03's dots and any section pill elsewhere in the
 * report agree. Every `BRAND_SECTIONS` member has an entry; `sectionTone`
 * falls back to neutral for an open-string section the list hasn't caught up
 * with (sections are open at the DB by design — see lib/brand-object/types.ts).
 *
 * Classes are written out in full because Tailwind scans source text — never
 * build them by interpolating a hue.
 */
import type { BrandSection } from '@/lib/brand-object/types';

export interface SectionTone {
  /** Human label for the pill, e.g. `value_prop` → "Value prop". */
  label: string;
  /** Background + text + border, light and dark. */
  pillClass: string;
}

export const NEUTRAL_PILL =
  'border-border/70 bg-muted/60 text-muted-foreground dark:bg-muted/30';

export const SECTION_TONE: Record<BrandSection, SectionTone> = {
  // Identity
  positioning: {
    label: 'Positioning',
    pillClass: 'border-chart-2/25 bg-chart-2/10 text-chart-2',
  },
  value_prop: {
    label: 'Value prop',
    pillClass: 'border-brand/25 bg-brand-soft text-brand-text',
  },
  usp: {
    label: 'USP',
    pillClass: 'border-chart-4/25 bg-chart-4/10 text-chart-4',
  },
  proof_point: {
    label: 'Proof point',
    pillClass:
      'border-teal-500/25 bg-teal-500/10 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  },
  voice: {
    label: 'Voice',
    pillClass:
      'border-cyan-500/25 bg-cyan-500/10 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300',
  },
  compliance: {
    label: 'Compliance',
    pillClass:
      'border-slate-500/25 bg-slate-500/10 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300',
  },
  // VOC — hues mirror VocReportPanel's KIND_CONFIG.
  voc_pain: {
    label: 'Pain',
    pillClass:
      'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  },
  voc_desire: {
    label: 'Desire',
    pillClass:
      'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  voc_objection: {
    label: 'Objection',
    pillClass:
      'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  },
  voc_praise: {
    label: 'Praise',
    pillClass:
      'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  },
  competitor_intel: {
    label: 'Competitor intel',
    pillClass:
      'border-orange-500/25 bg-orange-500/10 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  },
  // Market
  market_prior: {
    label: 'Market prior',
    pillClass:
      'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  },
  // Owned performance — distinct hue from market_prior on purpose: one is our
  // own realized spend, the other a competitor-longevity proxy.
  performance_prior: {
    label: 'Performance',
    pillClass:
      'border-lime-500/25 bg-lime-500/10 text-lime-700 dark:bg-lime-500/15 dark:text-lime-300',
  },
  // Synthesis
  persona: {
    label: 'Persona',
    pillClass:
      'border-pink-500/25 bg-pink-500/10 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300',
  },
};

/** Tone for any section string — neutral, sentence-cased fallback if unknown. */
export function sectionTone(section: string): SectionTone {
  return (
    SECTION_TONE[section as BrandSection] ?? {
      label: section.replace(/_/g, ' '),
      pillClass: NEUTRAL_PILL,
    }
  );
}

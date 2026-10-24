/**
 * Per-section-group completeness + brand object status derivation. PURE and
 * deterministic, PRESENCE-ONLY: the Brand Identity page is a report, not a
 * review queue, so completeness measures "do enough live facts exist?" and
 * never founder confirmation. Persisted on brand_object_state and rendered
 * as the coverage pill; the ready gate constants live in config.ts.
 */
import { BRAND_OBJECT_CONFIG } from './config';
import type {
  BrandObjectStatus,
  BrandSection,
  Completeness,
  FactStatus,
} from './types';

/** Section groups shown in the UI + used for scoring. */
export const SECTION_GROUPS: Record<string, readonly BrandSection[]> = {
  identity: ['positioning', 'value_prop', 'usp', 'proof_point', 'voice'],
  compliance: ['compliance'],
  voc: ['voc_pain', 'voc_desire', 'voc_objection', 'voc_praise'],
  market: ['market_prior', 'competitor_intel'],
  personas: ['persona'],
};

/** Live facts needed for full presence per group (soft targets). */
const PRESENCE_TARGETS: Record<string, number> = {
  identity: 5,
  compliance: 1,
  voc: 6,
  market: 3,
  personas: 2,
};

/** Groups that gate overall completeness. Compliance is advisory — many
 * brands legitimately have none, so it never drags overall down. */
const OVERALL_GROUPS = ['identity', 'voc', 'market', 'personas'] as const;

export interface FactForCompleteness {
  section: BrandSection;
  /** Kept for structural compat with LiveFact rows; live rows are never
   * 'rejected' (reject stamps valid_to in the same update). */
  status: FactStatus;
}

export function computeCompleteness(
  liveFacts: FactForCompleteness[],
): Completeness {
  const perSection: Record<string, number> = {};
  for (const [group, sections] of Object.entries(SECTION_GROUPS)) {
    const count = liveFacts.filter((f) => sections.includes(f.section)).length;
    const target = PRESENCE_TARGETS[group] ?? 1;
    perSection[group] = Math.round(Math.min(1, count / target) * 100) / 100;
  }
  const overall =
    Math.round(
      (OVERALL_GROUPS.reduce((sum, g) => sum + (perSection[g] ?? 0), 0) /
        OVERALL_GROUPS.length) *
        100,
    ) / 100;
  return { overall, perSection };
}

/**
 * Status derivation for non-building moments (processors set 'building'
 * while the chain runs). Presence-based: 'ready' once the report has enough
 * distilled data to stand on; below-gate maps to 'empty' ("not enough data
 * to report on yet" — no surface gates rendering on status, so partial facts
 * still display). 'in_review' is legacy and no longer derived.
 */
export function deriveStatus(
  liveFacts: FactForCompleteness[],
  completeness: Completeness,
): Exclude<BrandObjectStatus, 'building' | 'in_review'> {
  if (liveFacts.length === 0) return 'empty';
  const gate = BRAND_OBJECT_CONFIG.ready;
  const present = (sections: readonly BrandSection[]) =>
    liveFacts.filter((f) => sections.includes(f.section)).length;
  const ready =
    completeness.overall >= gate.minOverallCompleteness &&
    present(['positioning']) >= gate.minPositioningFacts &&
    present(['persona']) >= gate.minPersonaFacts &&
    present(SECTION_GROUPS.voc) >= gate.minVocFacts;
  return ready ? 'ready' : 'empty';
}

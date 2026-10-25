import { CONCEPTS } from '@/lib/adlab/contract';
import type { InsightFact } from '@/lib/brand-object/insights';
import { HOOK_PRODUCIBILITY, type HookRequirement } from '@/lib/creative-engine/generation/producibility';
import { producibleHookAllowlist, type StrategyPackHints } from '@/lib/creative-engine/generation/strategy';
import type { HookArchetype } from '@/services/ad-library/label-taxonomy';

/*
 * The closed vocabularies A4's rows use, and which hooks the brand facts can back.
 */

// The contract's vocabularies and id formats are shared with A5 and A6 (lib/adlab/contract.ts).
export { CONCEPTS, CONTROL_ARM_ID, FOOD_ANGLES as ANGLES, armIdFor, brandIdFor, segmentIdForFactKey as segmentIdFor } from '@/lib/adlab/contract';

/** Concepts the segment LLM weighs; `other` is never shown or claimed in the sim. */
export const WEIGHTED_CONCEPTS = CONCEPTS.filter((concept) => concept.key !== 'other');
export const OTHER_PRIOR_WEIGHT = 0.1;

/** Pack-row sections that are never `fact` rows (lib/creative-engine/brand-context/ingest.ts rowTypeForSection). */
const NON_FACT_SECTIONS = new Set(['voice', 'compliance', 'persona', 'performance_prior']);
const OFFER_RE = /(discount|% off|free shipping|free trial|bundle|money.?back|guarantee)/i;

export interface FactHints {
  hints: StrategyPackHints;
  /** The first fact that met each requirement, for the report. */
  metBy: Partial<Record<HookRequirement, string>>;
}

/**
 * Which hook requirements the brand facts meet, brand-wide: A5's derivePackHints
 * (CREATIVE_MANIFEST §4) on the live facts minus market_prior, which A5 drops
 * before compiling. A5 checks each segment's own rows on top (worker/creatives/pairs.ts).
 */
export function factHints(facts: InsightFact[]): FactHints {
  const live = facts.filter((fact) => fact.section !== 'market_prior');
  const factRows = live.filter((fact) => !NON_FACT_SECTIONS.has(fact.section));
  const numeric = factRows.find((fact) => /\d/.test(fact.statement));
  const socialProof = factRows.find((fact) => fact.section === 'proof_point' || fact.section === 'voc_praise');
  const verbatim = live.find((fact) => fact.section === 'persona' && Array.isArray(fact.details.verbatims) && fact.details.verbatims.length > 0);
  const offer = factRows.find((fact) => OFFER_RE.test(fact.statement));
  const describe = (fact: InsightFact | undefined) => fact && `[${fact.section}] ${fact.statement.slice(0, 100)}`;
  const metBy: FactHints['metBy'] = {
    numeric_fact: describe(numeric),
    social_proof_fact: describe(socialProof),
    customer_verbatim: verbatim && `[persona] ${String(verbatim.details.name)}`,
    offer_fact: describe(offer),
  };
  return {
    hints: {
      hasNumericFact: Boolean(numeric),
      hasSocialProofFact: Boolean(socialProof),
      hasCustomerVerbatim: Boolean(verbatim),
      hasOfferFact: Boolean(offer),
    },
    metBy,
  };
}

/** Hooks the copywriter can produce whose fact requirement the brand meets. */
export function allowedHooks(hints: StrategyPackHints): HookArchetype[] {
  return producibleHookAllowlist(hints);
}

export function hookRequirement(hook: string): HookRequirement | undefined {
  return HOOK_PRODUCIBILITY[hook as HookArchetype]?.requires;
}

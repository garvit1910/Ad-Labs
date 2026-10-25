import type { InsightFact } from '@/lib/brand-object/insights';
import { getAngleVocabulary } from '@/lib/brand-identity/industry-taxonomy';
import { slugify } from '@/lib/creative-engine/brand-context/ingest';
import { HOOK_PRODUCIBILITY, type HookRequirement } from '@/lib/creative-engine/generation/producibility';
import { producibleHookAllowlist, type StrategyPackHints } from '@/lib/creative-engine/generation/strategy';
import type { HookArchetype } from '@/services/ad-library/label-taxonomy';

/*
 * The closed vocabularies A4's rows use, and which hooks the brand facts can back.
 */

/**
 * The concept vocabulary (docs/PLAN.md "Simulation design"). Keys and labels match
 * B's sim/fixtures/magicspoon/concepts.json (D25), copied rather than imported:
 * A and B share only SpacetimeDB.
 */
export const CONCEPTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'high_protein', label: 'high protein' },
  { key: 'low_sugar', label: 'low sugar' },
  { key: 'low_carb_keto', label: 'low carb or keto' },
  { key: 'taste', label: 'taste' },
  { key: 'nostalgia', label: 'childhood flavors' },
  { key: 'crunch_texture', label: 'crunch' },
  { key: 'flavor_variety', label: 'flavor variety' },
  { key: 'clean_ingredients', label: 'clean ingredients' },
  { key: 'gluten_grain_free', label: 'gluten-free or grain-free' },
  { key: 'keeps_full', label: 'staying full until the next meal' },
  { key: 'fitness', label: 'fitness' },
  { key: 'weight_goals', label: 'weight goals' },
  { key: 'kid_friendly', label: 'kid-friendly' },
  { key: 'convenience', label: 'convenience' },
  { key: 'value_price', label: 'value for money' },
  { key: 'discount_offer', label: 'discounts' },
  { key: 'subscription', label: 'subscriptions' },
  { key: 'social_proof', label: 'what other customers say' },
  { key: 'other', label: 'other' },
];

/** Concepts the segment LLM weighs; `other` is never shown or claimed in the sim. */
export const WEIGHTED_CONCEPTS = CONCEPTS.filter((concept) => concept.key !== 'other');
export const OTHER_PRIOR_WEIGHT = 0.1;

/** Adcero's food-industry angle tokens plus price_value and trust_safety (the reducers' ANGLES). */
export const ANGLES: readonly string[] = getAngleVocabulary('food').filter((angle) => angle !== 'other');

export const brandIdFor = (name: string) => `br_${slugify(name)}`;
export const segmentIdFor = (personaFactKey: string) => `seg_${slugify(personaFactKey)}`;
export const armIdFor = (angle: string, hook: string) => `arm_${angle}_${hook}`;
export const CONTROL_ARM_ID = 'arm_control';

/** Pack-row sections that are never `fact` rows (lib/creative-engine/brand-context/ingest.ts rowTypeForSection). */
const NON_FACT_SECTIONS = new Set(['voice', 'compliance', 'persona', 'performance_prior']);
const OFFER_RE = /(discount|% off|free shipping|free trial|bundle|money.?back|guarantee)/i;

export interface FactHints {
  hints: StrategyPackHints;
  /** The first fact that met each requirement, for the report. */
  metBy: Partial<Record<HookRequirement, string>>;
}

/**
 * Which hook requirements the brand facts meet. Mirrors A5's derivePackHints
 * (CREATIVE_MANIFEST §4) on the live facts minus market_prior, which A5 drops
 * before compiling. Merge with A5's version once both land.
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

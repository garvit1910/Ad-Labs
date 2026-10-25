import { getAngleVocabulary } from '@/lib/brand-identity/industry-taxonomy';
import { slugify } from '@/lib/creative-engine/brand-context/ingest';
import { HOOK_PRODUCIBILITY } from '@/lib/creative-engine/generation/producibility';
import type { HookArchetype } from '@/services/ad-library/label-taxonomy';

/*
 * The contract's closed vocabularies and id formats (docs/PLAN.md "The contract" and
 * A4's "Hand-off to A5"), shared by A4's row builder, A5's creative worker and A6.
 * spacetime/src/reducers_a.ts enforces the same lists on every write.
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

/** A recipe's angle: Adcero's food-industry tokens plus price_value and trust_safety, never `other`. */
export const FOOD_ANGLES: readonly string[] = getAngleVocabulary('food').filter((angle) => angle !== 'other');

/** A recipe's hook: the HOOK_ARCHETYPES the copywriter can produce at all (never demo, comparison, other). */
export const RECIPE_HOOKS: readonly HookArchetype[] = (Object.keys(HOOK_PRODUCIBILITY) as HookArchetype[]).filter(
  (hook) => HOOK_PRODUCIBILITY[hook].status !== 'not_producible',
);

export const CONTROL_ARM_ID = 'arm_control';

export const brandIdFor = (name: string) => `br_${slugify(name)}`;
export const armIdFor = (angle: string, hook: string) => `arm_${angle}_${hook}`;
/** A persona fact's key → its segment: `macro-nostalgia-regular` → `seg_macro_nostalgia_regular`. */
export const segmentIdForFactKey = (personaFactKey: string) => `seg_${slugify(personaFactKey)}`;
/** Segment → the compiler's persona row id (`persona_` + the same slug). */
export const personaRefFor = (segmentId: string) => `persona_${segmentId.slice('seg_'.length)}`;
/** The compiler's persona row id → its segment. */
export const segmentIdForPersonaRow = (personaRowId: string) => `seg_${personaRowId.slice('persona_'.length)}`;

const CREATIVE_ID = /^cr_[a-z0-9_]+$/;

/**
 * A generated creative's id. Round 0 (`cr_g0_<arm>_<segment>_<variant>`) is shared by
 * every run. Later rounds carry the run (`cr_g<r>_<run>_<arm>_<segment>_<variant>`),
 * because the creative table has no run column: without it a second run would
 * overwrite the first run's creatives. Deterministic, so a rerun updates rows.
 */
export function generatedCreativeId(roundCreated: number, runId: string, armId: string, segmentId: string, variant: number): string {
  const run = roundCreated === 0 ? '' : `${slugify(runId.replace(/^run_/, ''))}_`;
  const id = `cr_g${roundCreated}_${run}${armId.slice('arm_'.length)}_${segmentId.slice('seg_'.length)}_${variant}`;
  if (!CREATIVE_ID.test(id)) throw new Error(`creative id "${id}" is not lowercase letters, digits and _`);
  return id;
}

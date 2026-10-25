import { getAngleVocabulary } from '@/lib/brand-identity/industry-taxonomy';
import {
  buildStrategyGroups,
  deterministicAngleDirective,
  producibleHookAllowlist,
  rankedProducibleFormats,
  type SelectStrategyInput,
  type SelectedStrategy,
} from '@/lib/creative-engine/generation/strategy';
import { ANGLES, type AdFormat, type HookArchetype } from '@/services/ad-library/label-taxonomy';

/** The arm table's angle vocabulary: Adcero's food-industry tokens, `other` excluded. */
export const FOOD_ANGLES: readonly string[] = getAngleVocabulary('food').filter((angle) => angle !== 'other');

/**
 * `food` for Ad Lab's recipes; `universal` (the 8 global ANGLES) only for the
 * Adcero fixture, whose arms use universal angles.
 */
export type AngleVocabulary = 'food' | 'universal';

export interface ChosenArm {
  angle: string;
  hookArchetype: string;
  format?: string;
}

/**
 * CREATIVE_MANIFEST §4's `strategyFromArms` (promoted from Adcero's
 * `arena/driver/operator.ts:73-100`), with the angle checked against the
 * food-industry vocabulary. One brief carries one angle; each arm's hook
 * becomes one strategy group, and a hook the pack hints can't back is a
 * caller bug (pairs are filtered and logged before this runs).
 */
export function strategyFromArms(
  arms: ChosenArm[],
  input: SelectStrategyInput,
  vocabulary: AngleVocabulary = 'food',
): SelectedStrategy {
  const angles = [...new Set(arms.map((a) => a.angle))];
  if (angles.length !== 1) throw new Error('one brief carries one angle: group arms by (segment, angle) first');
  const token = angles[0];
  const pickable: readonly string[] = vocabulary === 'food' ? FOOD_ANGLES : ANGLES.filter((angle) => angle !== 'other');
  if (!pickable.includes(token)) throw new Error(`angle "${token}" is not in the ${vocabulary} vocabulary`);
  const allowed = new Set<string>(producibleHookAllowlist(input.packHints));
  const hooks = arms.map((a) => a.hookArchetype);
  for (const h of hooks) if (!allowed.has(h)) throw new Error(`hook "${h}" is not producible under these pack hints`);
  if (new Set(hooks).size !== hooks.length) throw new Error('duplicate hook in one brief'); // group key is hook__format
  const fill = rankedProducibleFormats(input.signals, hooks.length);
  const formats = arms.map((a, i) => (a.format ?? fill[i % fill.length]) as AdFormat);
  return {
    angleKey: token,
    angleDirective: deterministicAngleDirective(token),
    groups: buildStrategyGroups(input.signals, hooks as HookArchetype[], formats, hooks.length),
    alternates: [],
    evidence: input.signals.slice(0, 12),
    fallbackTier: 'evidence',
  };
}

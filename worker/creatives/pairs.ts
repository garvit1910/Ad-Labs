import type { BrandContextRow } from '@/lib/creative-engine/brand-context/types';
import type { StrategyPackHints } from '@/lib/creative-engine/generation/strategy';
import { personaRefFor } from './facts';
import { derivePackHints, missingRequirement, segmentRows } from './pack-hints';
import { FOOD_ANGLES } from './strategy-from-arms';
import type { Pair, Recipe, Skip } from './types';

/**
 * Every (recipe, segment) pair the copywriter can produce, plus every pair it
 * can't, each logged with what's missing instead of dropped silently. The
 * expected one is testimonial on the unaware segment, which has no verbatims.
 */
export function planPairs(
  recipes: Recipe[],
  segmentIds: string[],
  rows: BrandContextRow[],
): { pairs: Pair[]; skips: Skip[] } {
  const hints = new Map<string, StrategyPackHints | null>();
  const hintsFor = (personaRef: string) => {
    if (!hints.has(personaRef)) {
      const own = segmentRows(rows, personaRef);
      hints.set(personaRef, own.length > 0 ? derivePackHints(own) : null);
    }
    return hints.get(personaRef)!;
  };

  const pairs: Pair[] = [];
  const skips: Skip[] = [];
  for (const recipe of recipes) {
    for (const segmentId of segmentIds) {
      const skip = (missing: string) => skips.push({ arm_id: recipe.arm_id, hook: recipe.hook, segment_id: segmentId, missing });
      // The control arm is Magic Spoon's own live ads; A5 never writes for it.
      if (recipe.strategy === 'control') {
        skip('control_arm');
        continue;
      }
      if (!FOOD_ANGLES.includes(recipe.angle)) {
        skip('food_angle');
        continue;
      }
      const personaRef = personaRefFor(segmentId);
      const segmentHints = hintsFor(personaRef);
      if (!segmentHints) {
        skip('persona_fact');
        continue;
      }
      const missing = missingRequirement(recipe.hook, segmentHints);
      if (missing) {
        skip(missing);
        continue;
      }
      pairs.push({ recipe, segmentId, personaRef });
    }
  }
  return { pairs, skips };
}

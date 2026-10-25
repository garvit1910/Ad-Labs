import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { derivePackHints, missingRequirement, segmentRows } from '@/worker/creatives/pack-hints';
import { planPairs } from '@/worker/creatives/pairs';
import type { Recipe } from '@/worker/creatives/types';
import { SEG_TRACKER, SEG_UNAWARE, testRows } from './helpers';

const recipe = (angle: string, hook: string, strategy = 'steal'): Recipe => ({
  arm_id: `arm_${angle}_${hook}`,
  angle,
  hook,
  strategy,
  rationale: 'test',
  evidence: [],
});

describe('segmentRows', () => {
  it('keeps the persona and the rows its spec tags admit, never another persona', () => {
    const own = segmentRows(testRows(), 'persona_unaware_projection');
    const ids = own.map((row) => row.rowId);
    assert.ok(ids.includes('persona_unaware_projection'));
    assert.ok(!ids.includes('persona_the_macro_tracker'));
    // The value prop is cited by the macro tracker only, so its audience tag keeps it out.
    assert.ok(!ids.includes('fact_value_prop_protein_per_bowl'));
    assert.ok(ids.includes('fact_proof_point_rating'));
  });

  it('returns nothing for a persona with no row', () => {
    assert.deepEqual(segmentRows(testRows(), 'persona_nobody'), []);
  });
});

describe('derivePackHints per segment', () => {
  it('gives the verbatim-free persona no customer verbatim', () => {
    const rows = testRows();
    assert.equal(derivePackHints(segmentRows(rows, 'persona_the_macro_tracker')).hasCustomerVerbatim, true);
    const unaware = derivePackHints(segmentRows(rows, 'persona_unaware_projection'));
    assert.equal(unaware.hasCustomerVerbatim, false);
    assert.equal(unaware.hasNumericFact, true);
  });
});

describe('missingRequirement', () => {
  const hints = { hasNumericFact: true, hasSocialProofFact: true, hasCustomerVerbatim: false, hasOfferFact: false };
  it('names the unmet HOOK_PRODUCIBILITY requirement', () => {
    assert.equal(missingRequirement('testimonial', hints), 'customer_verbatim');
    assert.equal(missingRequirement('offer_led', hints), 'offer_fact');
    assert.equal(missingRequirement('statistic', hints), null);
    assert.equal(missingRequirement('bold_claim', hints), null);
  });
  it('treats never-producible and unknown hooks as not_producible', () => {
    assert.equal(missingRequirement('demo', hints), 'not_producible');
    assert.equal(missingRequirement('comparison', hints), 'not_producible');
    assert.equal(missingRequirement('jingle', hints), 'not_producible');
  });
});

describe('planPairs', () => {
  it('logs testimonial on the unaware segment instead of dropping it', () => {
    const recipes = [recipe('taste_indulgence', 'testimonial'), recipe('health_nutrition', 'statistic')];
    const { pairs, skips } = planPairs(recipes, [SEG_TRACKER, SEG_UNAWARE], testRows());
    assert.equal(pairs.length, 3);
    assert.deepEqual(skips, [
      { arm_id: 'arm_taste_indulgence_testimonial', hook: 'testimonial', segment_id: SEG_UNAWARE, missing: 'customer_verbatim' },
    ]);
    assert.equal(pairs[0].personaRef, 'persona_the_macro_tracker');
  });

  it('skips the control arm, off-vocabulary angles and segments with no persona fact', () => {
    const control = { ...recipe('', ''), arm_id: 'arm_control', strategy: 'control' };
    const { pairs, skips } = planPairs([control, recipe('health', 'bold_claim'), recipe('craving', 'question')], [SEG_TRACKER, 'seg_ghost'], testRows());
    assert.deepEqual(
      pairs.map((pair) => `${pair.recipe.arm_id}/${pair.segmentId}`),
      ['arm_craving_question/seg_the_macro_tracker'],
    );
    assert.deepEqual(
      skips.map((skip) => `${skip.arm_id}/${skip.segment_id}: ${skip.missing}`),
      [
        'arm_control/seg_the_macro_tracker: control_arm',
        'arm_control/seg_ghost: control_arm',
        'arm_health_bold_claim/seg_the_macro_tracker: food_angle',
        'arm_health_bold_claim/seg_ghost: food_angle',
        'arm_craving_question/seg_ghost: persona_fact',
      ],
    );
  });
});

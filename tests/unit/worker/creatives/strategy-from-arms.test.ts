import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FOOD_ANGLES, strategyFromArms } from '@/worker/creatives/strategy-from-arms';

const allHints = { hasNumericFact: true, hasSocialProofFact: true, hasCustomerVerbatim: true, hasOfferFact: false };
const input = { signals: [], packHints: allHints, goal: 'conversions', platform: 'meta' };

describe('strategyFromArms', () => {
  it('uses the 8 food-industry tokens as its vocabulary', () => {
    assert.deepEqual([...FOOD_ANGLES].sort(), [
      'convenience',
      'craving',
      'dietary_fit',
      'health_nutrition',
      'natural_clean',
      'price_value',
      'taste_indulgence',
      'trust_safety',
    ]);
  });

  it('turns one angle and its hooks into one group per hook', () => {
    const selected = strategyFromArms(
      [
        { angle: 'health_nutrition', hookArchetype: 'statistic' },
        { angle: 'health_nutrition', hookArchetype: 'testimonial' },
      ],
      input,
    );
    assert.equal(selected.angleKey, 'health_nutrition');
    assert.equal(selected.angleDirective, 'Lead with the health nutrition angle proven by winning ads in this market');
    assert.equal(selected.fallbackTier, 'evidence');
    assert.deepEqual(
      selected.groups.map((group) => group.key),
      ['statistic__lifestyle_static', 'testimonial__product_only_static'],
    );
  });

  it('rejects a universal angle in food mode and accepts it in universal mode', () => {
    const arms = [{ angle: 'health', hookArchetype: 'bold_claim' }];
    assert.throws(() => strategyFromArms(arms, input), /not in the food vocabulary/);
    assert.equal(strategyFromArms(arms, input, 'universal').angleKey, 'health');
  });

  it('rejects hooks the pack hints cannot back, duplicates, and mixed angles', () => {
    assert.throws(() => strategyFromArms([{ angle: 'price_value', hookArchetype: 'offer_led' }], input), /not producible/);
    assert.throws(() => strategyFromArms([{ angle: 'craving', hookArchetype: 'demo' }], input), /not producible/);
    assert.throws(
      () =>
        strategyFromArms(
          [
            { angle: 'craving', hookArchetype: 'question' },
            { angle: 'craving', hookArchetype: 'question' },
          ],
          input,
        ),
      /duplicate hook/,
    );
    assert.throws(
      () =>
        strategyFromArms(
          [
            { angle: 'craving', hookArchetype: 'question' },
            { angle: 'convenience', hookArchetype: 'curiosity' },
          ],
          input,
        ),
      /one brief carries one angle/,
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkA4Rows, readA4Tables, type A4Tables } from '@/worker/creatives/check';
import { a4Tables, FakeStdb, SEG_UNAWARE, testRows } from './helpers';

const tables = () => readA4Tables(new FakeStdb(a4Tables()));

async function failuresWith(edit: (t: A4Tables) => void): Promise<string[]> {
  const t = await tables();
  edit(t);
  return checkA4Rows(t, testRows()).failures;
}

describe('checkA4Rows', () => {
  it('passes on usable rows and reports the round-0 count against the logged skips', async () => {
    const result = checkA4Rows(await tables(), testRows());
    assert.deepEqual(result.failures, []);
    assert.equal(result.brand?.brand_id, 'br_halden_oat_co');
    assert.equal(result.controlArmId, 'arm_control');
    assert.equal(result.landingProductId, 'prd_halden_box');
    assert.equal(result.recipes.length, 10);
    assert.deepEqual(result.skips, [
      { arm_id: 'arm_taste_indulgence_testimonial', hook: 'testimonial', segment_id: SEG_UNAWARE, missing: 'customer_verbatim' },
    ]);
    assert.equal(result.expected, 10 * 2 - 1);
  });

  it('lists every failure, not just the first', async () => {
    const failures = await failuresWith((t) => {
      t.brands = [];
      t.segments = t.segments.slice(0, 1);
      t.arms = t.arms.filter((arm) => arm.strategy !== 'control');
      t.products = [];
    });
    assert.deepEqual(failures, [
      'brand: expected exactly one is_client row, found 0',
      'segment: expected at least 2 rows, found 1',
      'segment: shares sum to 0.7, not 1',
      'arm: expected exactly one control arm, found 0',
      "product: no product row for the client brand yet (B's); generated creatives need a landing_product_id",
    ]);
  });

  it('checks segments against the live persona facts', async () => {
    const failures = await failuresWith((t) => {
      t.segments[1] = { ...t.segments[1], segment_id: 'seg_ghost' };
    });
    assert.deepEqual(failures, ['segment seg_ghost: no live persona fact (persona_ghost)']);
  });

  it('checks the recipe count, vocabulary and unique (angle, hook) pairs', async () => {
    const failures = await failuresWith((t) => {
      t.arms = t.arms.filter((arm) => arm.arm_id !== 'arm_price_value_bold_claim');
      t.arms.push(
        { arm_id: 'arm_health_bold_claim', angle: 'health', hook: 'bold_claim', strategy: 'steal', rationale: 'x', evidence: '[]' },
        { arm_id: 'arm_craving_jingle', angle: 'craving', hook: 'jingle', strategy: 'gap', rationale: 'x', evidence: 'oops' },
        { arm_id: 'arm_convenience_problem_callout_2', angle: 'convenience', hook: 'problem_callout', strategy: 'steal', rationale: 'x', evidence: '[]' },
      );
    });
    assert.deepEqual(failures, [
      'arm arm_craving_jingle: evidence is not a JSON array of strings',
      'arm arm_convenience_problem_callout_2: same (angle, hook) as arm_convenience_problem_callout',
      'arm arm_craving_jingle: hook "jingle" is not a HOOK_ARCHETYPE',
      'arm arm_health_bold_claim: angle "health" is not a food-industry token',
    ]);
  });

  it('waits for A4 to write the live ads, and for B to add a client product', async () => {
    const failures = await failuresWith((t) => {
      t.brandLive = [];
      t.products = [{ product_id: 'prd_rival', brand_id: 'br_rival_crunch', name: 'Rival' }];
    });
    assert.deepEqual(failures, [
      'creative: the control arm arm_control has no brand_live creative yet (A4 writes them last)',
      "product: no product row for br_halden_oat_co yet (B's); generated creatives need a landing_product_id",
    ]);
  });

  it('lands on the lowest product_id when B has several, with a warning', async () => {
    const t = await tables();
    t.products.push({ product_id: 'prd_halden_bars', brand_id: 'br_halden_oat_co', name: 'Bars' });
    const result = checkA4Rows(t, testRows());
    assert.equal(result.landingProductId, 'prd_halden_bars');
    assert.deepEqual(result.warnings, ['product: 2 rows for br_halden_oat_co; landing on prd_halden_bars']);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATE_WORD_LIMIT, worstStateWords } from '@/lib/adlab/contract-check';
import { checkA4Rows, readA4Tables, type A4Tables } from '@/worker/creatives/check';
import { a4Tables, FakeStdb, SEG_UNAWARE, testRows } from './helpers';

const tables = () => readA4Tables(new FakeStdb(a4Tables()));

async function failuresWith(edit: (t: A4Tables) => void): Promise<string[]> {
  const t = await tables();
  edit(t);
  return checkA4Rows(t, testRows()).failures;
}

const has = (failures: string[], text: string) => assert.ok(failures.some((failure) => failure.includes(text)), `no failure mentions "${text}":\n${failures.join('\n')}`);

describe('checkA4Rows (the shared contract check, from A5)', () => {
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
    assert.ok(result.worstStateWords > 0 && result.worstStateWords < STATE_WORD_LIMIT);
  });

  it('lists every failure, not just the first', async () => {
    const failures = await failuresWith((t) => {
      t.brands = [];
      t.segments = t.segments.slice(0, 1);
      t.arms = t.arms.filter((arm) => arm.strategy !== 'control');
      t.products = [];
    });
    has(failures, 'exactly one client brand (none)');
    has(failures, '1 segments (need 2)');
    has(failures, 'segment shares sum to 0.700000000');
    has(failures, 'every live persona has a segment (missing: seg_unaware_projection)');
    has(failures, 'exactly one control arm, arm_control (none)');
    has(failures, 'B has written a product for the client (0, no client brand yet)');
  });

  it('checks segments against the live persona facts', async () => {
    const failures = await failuresWith((t) => {
      t.segments[1] = { ...t.segments[1], segment_id: 'seg_ghost' };
    });
    has(failures, 'every segment maps to a live persona fact (not: seg_ghost)');
  });

  it('checks the recipe count, vocabulary, backing and unique (angle, hook) pairs', async () => {
    const failures = await failuresWith((t) => {
      t.arms = t.arms.filter((arm) => arm.arm_id !== 'arm_price_value_bold_claim');
      t.arms.push(
        { arm_id: 'arm_health_bold_claim', angle: 'health', hook: 'bold_claim', strategy: 'steal', evidence: '[]' },
        { arm_id: 'arm_craving_jingle', angle: 'craving', hook: 'jingle', strategy: 'gap', evidence: 'oops' },
        { arm_id: 'arm_price_value_offer_led', angle: 'price_value', hook: 'offer_led', strategy: 'steal', evidence: '[]' },
        { arm_id: 'arm_convenience_problem_callout_2', angle: 'convenience', hook: 'problem_callout', strategy: 'steal', evidence: '[]' },
      );
    });
    has(failures, '13 recipes (need 10-12)');
    has(failures, 'every recipe angle is a food token (not: arm_health_bold_claim)');
    has(failures, "every recipe hook is one the copywriter can produce (not: arm_craving_jingle)");
    // The fixture brand has no offer fact, so offer_led can't be backed.
    has(failures, "every recipe hook's fact requirement is met by the brand facts (not: arm_price_value_offer_led)");
    has(failures, 'every (angle, hook) pair is unique');
    has(failures, "every arm's evidence is a JSON list of ids (not: arm_craving_jingle)");
  });

  it('waits for B to add a client product, and rejects a stray product', async () => {
    const failures = await failuresWith((t) => {
      t.products = [{ product_id: 'prd_three_wishes', brand_id: 'br_three_wishes', name: 'Three Wishes' }];
    });
    has(failures, 'every client creative lands on a client product in B\'s product table (not yet: prd_halden_box');
    has(failures, "every product's brand exists (B's loader rejects: prd_three_wishes)");
  });

  it('fails when the longest possible Jev state would reach B’s 450-word limit', async () => {
    const t = await tables();
    t.creatives[1] = { ...t.creatives[1], primary_text: Array.from({ length: 260 }, () => 'crunchy').join(' ') };
    const result = checkA4Rows(t, testRows());
    assert.ok(worstStateWords(t) >= STATE_WORD_LIMIT);
    has(result.failures, `(B throws at ${STATE_WORD_LIMIT})`);
  });

  it('lands generated ads where the live ads land when B has several products', async () => {
    const t = await tables();
    t.products.unshift({ product_id: 'prd_aaa_bars', brand_id: 'br_halden_oat_co', name: 'Bars' });
    const result = checkA4Rows(t, testRows());
    assert.equal(result.landingProductId, 'prd_halden_box');
    assert.deepEqual(result.warnings.filter((w) => w.startsWith('product:')), ['product: 2 rows for br_halden_oat_co; landing on prd_halden_box']);
  });
});

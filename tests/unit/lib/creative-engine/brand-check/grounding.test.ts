import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findUngroundedNumerals } from '@/lib/creative-engine/brand-check/grounding';

const ungrounded = (copy: string, grounding: string) =>
  findUngroundedNumerals({ headline: copy, primaryText: '' }, grounding);

describe('findUngroundedNumerals matches whole numbers', () => {
  it('does not ground a number on a longer one that contains its digits', () => {
    assert.deepEqual(ungrounded('Join 30 happy customers', 'Over 3,000 reviews'), ['30']);
    assert.deepEqual(ungrounded('30 bowls', '130 bowls a year since 2030, 300 flavors'), ['30']);
    assert.deepEqual(ungrounded('Rated 4 stars', 'Rated 4.7 out of 5'), ['4']);
  });

  it('keeps the decimal point significant', () => {
    assert.deepEqual(ungrounded('Rated 4.7 stars', 'Rated 4.7 out of 5'), []);
    assert.deepEqual(ungrounded('47 stars', 'Rated 4.7 out of 5'), ['47']);
  });

  it('treats thousands commas and trailing punctuation as spelling', () => {
    assert.deepEqual(ungrounded('3,000 reviews', 'over 3000 reviews'), []);
    assert.deepEqual(ungrounded('3000 reviews', 'over 3,000 reviews'), []);
    assert.deepEqual(ungrounded('Rated 4.7.', 'Rated 4.7 out of 5.'), []);
    assert.deepEqual(ungrounded('13g of protein', 'Each bowl has 13g protein'), []);
  });

  it("keeps Adcero's existing behaviour for headline + primary text", () => {
    assert.deepEqual(
      findUngroundedNumerals(
        { headline: '1,000+ five-star reviews', primaryText: '24 servings' },
        'over 1000 reviews on record',
      ),
      ['24'],
    );
  });

  it('reports each ungrounded token once, as written', () => {
    assert.deepEqual(ungrounded('30 bowls, 30 days, 12.', 'no numbers here'), ['30', '12.']);
  });
});

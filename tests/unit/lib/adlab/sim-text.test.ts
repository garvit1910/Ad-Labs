import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clipWords, feedHeadline, feedImage, feedPrimary, flat } from '@/lib/adlab/sim-text';

describe('flat', () => {
  it('collapses line breaks and runs of spaces', () => {
    assert.equal(flat('  One line\n\nand   another.  '), 'One line and another.');
  });
});

describe('clipWords', () => {
  it('keeps text that fits, then whole leading sentences, then a feed-style cut', () => {
    assert.equal(clipWords('Short and sweet.', 5), 'Short and sweet.');
    assert.equal(clipWords('One two three. Four five six. Seven eight nine ten.', 7), 'One two three. Four five six.');
    assert.equal(clipWords('A single long sentence that keeps going well past the limit.', 5), 'A single long sentence that…');
  });

  it('caps feed headlines and primary text', () => {
    assert.equal(feedHeadline('Twelve words in this headline is more than a feed shows at once'), 'Twelve words in this headline is more than a feed…');
    const body = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    assert.equal(feedPrimary(body).split(' ').length, 25);
  });
});

describe('feedImage', () => {
  it('keeps a short first sentence and cuts a long one at a clause', () => {
    assert.equal(feedImage('A bowl of cereal on a table. A second sentence.'), 'A bowl of cereal on a table.');
    assert.equal(
      feedImage('A sunlit kitchen counter with a bowl of colorful cereal, milk pouring in from a glass jug.'),
      'A sunlit kitchen counter with a bowl of colorful cereal.',
    );
  });

  it('never ends a cut on a dangling article or preposition', () => {
    assert.equal(feedImage('A person holds the product while they walk with the dog in a sunny park'), 'A person holds the product while they walk with the dog.');
  });
});

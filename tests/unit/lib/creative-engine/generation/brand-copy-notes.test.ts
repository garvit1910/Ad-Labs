import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { generateBrandCopy } from '@/lib/creative-engine/generation/brand-copy';
import { briefFixture, CLEAN_COPY, mockChat } from '../../../worker/creatives/helpers';

// Ad Lab's one edit to copied Adcero code: an optional `notes` list in the strategy block.
const fixtureBrief = briefFixture.briefs[0];
const group = fixtureBrief.selectedStrategy.groups[1]; // social_proof: no number needed
const recorded = fixtureBrief.copyRequests[2]; // that group's recorded request
const input = (notes?: string[]) => ({
  copyPrompt: fixtureBrief.copyPrompt,
  brief: fixtureBrief.brief,
  strategy: {
    key: group.key,
    hookDirective: group.hookDirective,
    sceneDirective: group.sceneDirective,
    ...(notes ? { notes } : {}),
  },
});

let restore = () => {};
afterEach(() => restore());

describe('generateBrandCopy strategy notes', () => {
  it('sends the recorded fixture request byte for byte when there are no notes', async () => {
    const mock = mockChat(() => CLEAN_COPY);
    restore = mock.restore;
    await generateBrandCopy(input());
    await generateBrandCopy(input([]));
    assert.equal(mock.calls[0].messages[1].content, recorded.messages[1].content);
    assert.equal(mock.calls[1].messages[1].content, recorded.messages[1].content);
  });

  it('renders the notes as "Notes from testing" inside the strategy block', async () => {
    const mock = mockChat(() => CLEAN_COPY);
    restore = mock.restore;
    await generateBrandCopy(input(['Address taste doubts early for  The Macro Tracker.', '  ']));
    const user = mock.calls[0].messages[1].content;
    assert.ok(
      user.includes('\nNotes from testing:\n- Address taste doubts early for The Macro Tracker.\n\n## Output format'),
      user.slice(user.indexOf('## Strategy')),
    );
  });

  it('never lets a number in a note ground a number in the copy', async () => {
    const mock = mockChat((_, index) =>
      index === 0 ? { ...CLEAN_COPY, headline: '37 grams of morning fuel' } : CLEAN_COPY,
    );
    restore = mock.restore;
    const result = await generateBrandCopy(input(['Lead with the 37 grams figure.']));
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[1].messages[1].content, /not present in any brand fact: 37/);
    assert.equal(result.source, 'llm');
    assert.equal(result.copy.headline, CLEAN_COPY.headline);
  });
});

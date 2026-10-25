import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readA4Tables } from '@/worker/creatives/check';
import { roundZeroStatusOf, runRound0, simVisual } from '@/worker/creatives/run';
import { a4Tables, briefFixture, CLEAN_COPY, FakeStdb, mockChat, testRows } from './helpers';

const client = () => ({ brandProfileId: briefFixture.briefs[0].pack.meta.brandProfileId as string, rows: testRows(), dropped: 0 });
const quiet = () => {};
let restore = () => {};
afterEach(() => restore());

// 10 recipes × 2 segments − the testimonial × unaware skip.
const EXPECTED = 19;

describe('runRound0', () => {
  it('writes one creative per (recipe, segment) in a single transaction and reports round 0 complete', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const db = new FakeStdb(a4Tables());
    const report = await runRound0({ spacetime: db, client: client(), log: quiet });
    assert.equal(report.expected, EXPECTED);
    assert.equal(report.written, EXPECTED);
    assert.equal(report.kept, 0);
    assert.deepEqual(db.reducerCalls.map((call) => call.reducer), ['upsert_creatives']);
    assert.equal(report.status.complete, true);
    assert.deepEqual(report.status.problems, []);
    const generated = db.tables.creative.filter((creative) => creative.origin === 'generated');
    assert.equal(generated.length, EXPECTED);
    assert.ok(generated.every((creative) => /^cr_g0_[a-z0-9_]+_1$/.test(String(creative.creative_id)) && creative.round_created === 0));
  });

  it('writes only what is missing or gated out on a rerun', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const db = new FakeStdb(a4Tables());
    await runRound0({ spacetime: db, client: client(), log: quiet });
    const gone = db.tables.creative.findIndex((creative) => creative.origin === 'generated');
    const removed = db.tables.creative.splice(gone, 1)[0];
    const before = chat.calls.length;
    const report = await runRound0({ spacetime: db, client: client(), log: quiet });
    assert.equal(report.kept, EXPECTED - 1);
    assert.equal(report.written, 1);
    assert.equal(report.creatives[0].row.creative_id, removed.creative_id);
    assert.equal(chat.calls.length - before, 1);
  });

  it('refuses once B has started a run, unless forced', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const db = new FakeStdb({ ...a4Tables(), run: [{ run_id: 'run_demo', rounds_planned: 5 }] });
    await assert.rejects(runRound0({ spacetime: db, client: client(), log: quiet }), /B has started \(run_demo\)/);
    assert.equal(chat.calls.length, 0);
    const forced = await runRound0({ spacetime: db, client: client(), log: quiet, force: true });
    assert.equal(forced.written, EXPECTED);
  });

  it('gives a pair whose creative gated out one more try', async () => {
    const seen = new Set<string>();
    const chat = mockChat((body) => {
      const hook = /^Hook archetype to execute: (.*)$/m.exec(body.messages[1].content)?.[1] ?? '';
      const first = !seen.has(hook);
      seen.add(hook);
      // An unparseable reply isn't retried by generateBrandCopy, so the set falls back and gates out.
      return first && hook.startsWith('Lead with the exact number') ? ({ broken: true } as Record<string, unknown>) : CLEAN_COPY;
    });
    restore = chat.restore;
    const db = new FakeStdb(a4Tables());
    const report = await runRound0({ spacetime: db, client: client(), log: quiet });
    assert.equal(report.gatedOut, 0);
    assert.equal(report.status.complete, true);
  });
});

describe('roundZeroStatusOf', () => {
  it('names what is missing, what gated out, and recipes the sim would drop', async () => {
    const tables = await readA4Tables(new FakeStdb(a4Tables()));
    const none = roundZeroStatusOf(tables, testRows());
    assert.equal(none.complete, false);
    assert.equal(none.missing.length, EXPECTED);
    assert.equal(none.recipesWithoutRanked.length, 10);

    const generated = (armSegment: string, status: string) => ({
      ...tables.creatives[0],
      creative_id: `cr_g0_${armSegment}_1`,
      origin: 'generated',
      status,
    });
    tables.creatives.push(generated('price_value_bold_claim_the_macro_tracker', 'gated_out'));
    const some = roundZeroStatusOf(tables, testRows());
    assert.deepEqual(some.gatedOut, ['cr_g0_price_value_bold_claim_the_macro_tracker_1']);
    assert.equal(some.missing.length, EXPECTED - 1);
  });
});

describe('simVisual', () => {
  it('keeps a short concept and cuts a long one to its first clause or 12 words', () => {
    assert.equal(simVisual('A bowl of cereal on a table.'), 'A bowl of cereal on a table.');
    assert.equal(
      simVisual('A sunlit kitchen counter with a bowl of colorful cereal, milk pouring in from a glass jug while a cat watches nearby. Second sentence.'),
      'A sunlit kitchen counter with a bowl of colorful cereal.',
    );
    assert.equal(
      simVisual('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'),
      'one two three four five six seven eight nine ten eleven twelve.',
    );
    assert.equal(simVisual('Line one\n\nline   two.'), 'Line one line two.');
  });
});

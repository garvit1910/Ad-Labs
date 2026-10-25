import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildVocCandidates, type PhraseForPromotion, type QuoteForPromotion } from '@/lib/brand-object/promotion';

const theme = { id: 't1', kind: 'pain', scope: 'brand', label: 'Double billing', summary: null, isCatchall: false, mentionCount: 3 };
const member = (id: string, mentionId: string, phrase: string): PhraseForPromotion => ({ id, themeId: 't1', mentionId, kind: 'pain', phrase });
const quote = (id: string, mentionId: string, phrase: string): QuoteForPromotion => ({ id, mentionId, phrase });

function quotedIds(phrases: PhraseForPromotion[], quotes: QuoteForPromotion[]): string[] {
  const mentionById = new Map(
    ['m1', 'm2', 'm3'].map((id) => [id, { id, platform: 'trustpilot', url: `https://example.com/${id}`, postedAt: null }]),
  );
  const [candidate] = buildVocCandidates({ themes: [theme], phrases, quotes, mentionById, now: new Date('2026-10-24T00:00:00Z') });
  return candidate.evidence.filter((ref) => ref.type === 'phrase' && ref.quote).map((ref) => ref.id!);
}

describe('buildVocCandidates quotes what the theme is about (Ad Lab)', () => {
  it("quotes the mention's quote that says the member phrase, not its first quote", () => {
    const ids = quotedIds(
      [member('p1', 'm1', 'double charged my card')],
      [
        quote('q1', 'm1', 'This cereal tastes of protein shake powder and turns my stomach.'),
        quote('q2', 'm1', 'They double charged my card and left me with no order.'),
      ],
    );
    assert.deepEqual(ids, ['q2']);
  });

  it('skips a mention whose quotes are all about something else', () => {
    const ids = quotedIds(
      [member('p1', 'm1', 'charged twice for one box'), member('p2', 'm2', 'billed me twice')],
      [quote('q1', 'm1', 'Worst cereal I have ever had.'), quote('q2', 'm2', 'They billed me twice and never answered my emails.')],
    );
    assert.deepEqual(ids, ['q2']);
  });

  it('lets a later member from the same mention find its quote', () => {
    const ids = quotedIds(
      [member('p1', 'm3', 'no refund'), member('p2', 'm3', 'charged my card twice')],
      [quote('q1', 'm3', 'Support charged my card twice for one order.')],
    );
    assert.deepEqual(ids, ['q1']);
  });

  it('matches across case and spacing, and a quote inside a longer phrase', () => {
    const ids = quotedIds(
      [member('p1', 'm1', 'They  DOUBLE charged me'), member('p2', 'm2', 'they charged me twice and the box never came')],
      [quote('q1', 'm1', 'they double charged me'), quote('q2', 'm2', 'the box never came')],
    );
    assert.deepEqual(ids, ['q1', 'q2']);
  });
});

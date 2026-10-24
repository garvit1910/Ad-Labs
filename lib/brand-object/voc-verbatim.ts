/**
 * Pure ranking for the customer quote Chapter 03 shows — PURE, no IO.
 *
 * A VOC fact carries every substring-verified quote its theme was clustered
 * from, and both display surfaces took `evidence[0]` — write order, which is
 * not quality order. On Magic Spoon the chapter headline read “Magic spoon”
 * (the brand name, 134 mentions of "Liked the flavor") because that two-word
 * comment happened to be stored first; the line that actually shows the theme
 * ("Love this flavor", "The cocoa version is our favorite so far") sat behind
 * it. Other themes lead with "Amazing site", "excellent son 😁", "I wish!!!!".
 *
 * A VOC quote earns its place by SAYING something a reader could not already
 * read off the theme label + mention count: a specific experience, verdict or
 * reason, long enough to carry a clause. Negative sentiment is fine — pains
 * and objections are made of it — what disqualifies a line is that it is a
 * fragment, an echo of the label, or promo/spam addressed at the brand.
 *
 * Read-time scoring over stored text: no re-distillation and no schema change,
 * so every fact already in the DB re-ranks on the next render. Mirrors
 * `personas/verbatim-rank.ts`, which does the same job for persona cards;
 * the two bands differ because a persona quote must portray a PERSON while a
 * VOC quote must evidence a THEME.
 */

import { isQuoteInMerchantLanguage } from './quote-language';

/** A quote needs a clause to be worth quoting; a card can't hold a paragraph. */
const IDEAL_MIN = 35;
const IDEAL_MAX = 170;
const HARD_MIN = 18;
const HARD_MAX = 260;

/** Below this the quote adds nothing the label already said — omit it. */
export const MIN_VOC_VERBATIM_SCORE = 0.3;
/**
 * The chapter headline is read before any theme context, so it clears a higher
 * bar than a quote sitting under its own labelled card.
 */
export const MIN_VOC_HERO_SCORE = 0.5;

/** Substance is counted in content words, so function words don't inflate it. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'but', 'or', 'so', 'if', 'then', 'than', 'that',
  'this', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
  'should', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as',
  'it', 'its', 'my', 'me', 'mine', 'you', 'your', 'we', 'our', 'us', 'they',
  'them', 'their', 'he', 'she', 'his', 'her', 'not', 'no', 'very', 'just',
  'too', 'all', 'any', 'some', 'out', 'up', 'about', 'into', 'over', 'i',
]);

/** Ideal band scores 1, tapering to 0 at the hard bounds. */
function lengthScore(len: number): number {
  if (len >= IDEAL_MIN && len <= IDEAL_MAX) return 1;
  if (len < IDEAL_MIN) return Math.max(0, (len - HARD_MIN) / (IDEAL_MIN - HARD_MIN));
  return Math.max(0, (HARD_MAX - len) / (HARD_MAX - IDEAL_MAX));
}

function contentWords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) ?? [];
  return words.filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Prefix-matched at 4 characters so "Tastes like a foot" counts as touching
 * "Bad taste" — a stemmer would be more accurate and is not worth the weight.
 */
function sharesStem(word: string, others: string[]): boolean {
  return others.some(
    (other) =>
      word.startsWith(other.slice(0, 4)) || other.startsWith(word.slice(0, 4)),
  );
}

const FIRST_PERSON_RE =
  /\b(i|i['’]?m|i['’]?ve|i['’]?d|i['’]?ll|my|me|mine|we|we['’]?re|our|us)\b/i;

/** Handles, links and shop-my-service pitches — an advert, not a customer. */
const PROMO_RE = /(@\w|https?:\/\/|www\.|\w+\.(com|net|io|co|shop)\b|link in bio|dm me|dm us)/i;

/** Shouted words read as a headline, not a person talking. */
const SHOUT_RE = /\b[A-Z]{3,}\b/;

/**
 * A question is a customer asking, not a customer reporting — it evidences
 * that someone wondered, never that the theme is true. Aux-inversion needs its
 * subject ("is this…"), or every "Delivery is slow" reads as a question.
 */
const WH_INITIAL_RE = /^(?:\W*\w+[\s,]+)?(what|why|when|where|how|which|who)\b/i;
const AUX_INVERSION_RE =
  /^(?:\W*\w+[\s,]+)?(do|does|did|can|could|will|would|should|are|is|was|have|has|any)\s+(you|u|i|we|they|it|this|these|those|there|any|the|your)\b/i;

/**
 * A quote too short, too long, too sparse in letters, or built entirely out of
 * its own theme label's vocabulary ("The clothing is excellent quality." under
 * "Excellent clothing quality") tells the reader nothing the label did not.
 */
export function isDisqualifiedVocVerbatim(
  quote: string,
  label?: string | null,
): boolean {
  const trimmed = quote.trim();
  if (trimmed.length < HARD_MIN || trimmed.length > HARD_MAX) return true;
  // A reader of an English report cannot use a Dutch review, however apt.
  if (!isQuoteInMerchantLanguage(trimmed)) return true;
  const letters = trimmed.replace(/[^\p{L}]/gu, '').length;
  if (letters < 14 || letters / trimmed.length < 0.5) return true;
  const words = contentWords(trimmed);
  if (words.length < 3) return true;
  if (label) {
    const labelWords = contentWords(label);
    if (
      labelWords.length > 0 &&
      words.every((word) => sharesStem(word, labelWords))
    ) {
      return true;
    }
  }
  return false;
}

/** True when the quote shares a distinctive word with the theme it evidences. */
function echoesTheme(quote: string, label: string): boolean {
  const quoteWords = contentWords(quote);
  return contentWords(label).some((labelWord) =>
    sharesStem(labelWord, quoteWords),
  );
}

/**
 * Higher = more worth quoting under this theme. Disqualified lines score 0.
 * A quotable length and specific vocabulary carry the base; the multipliers
 * strip out adverts and shouted fragments, and a line that never touches its
 * own theme is nudged behind one that does.
 */
export function scoreVocVerbatim(quote: string, label?: string | null): number {
  const trimmed = quote.trim();
  if (isDisqualifiedVocVerbatim(trimmed, label)) return 0;

  const specificity = Math.min(1, contentWords(trimmed).length / 7);
  const base = 0.55 * lengthScore(trimmed.length) + 0.45 * specificity;

  const firstPersonBonus = FIRST_PERSON_RE.test(trimmed) ? 1 : 0.9;
  const promoPenalty = PROMO_RE.test(trimmed) ? 0.35 : 1;
  const isQuestion =
    trimmed.includes('?') ||
    WH_INITIAL_RE.test(trimmed) ||
    AUX_INVERSION_RE.test(trimmed);
  const questionPenalty = isQuestion ? 0.5 : 1;
  const shoutPenalty = SHOUT_RE.test(trimmed) ? 0.7 : 1;
  const exclaimPenalty = (trimmed.match(/!/g) ?? []).length >= 2 ? 0.8 : 1;
  const offThemePenalty = label && !echoesTheme(trimmed, label) ? 0.85 : 1;

  return (
    base *
    firstPersonBonus *
    promoPenalty *
    questionPenalty *
    shoutPenalty *
    exclaimPenalty *
    offThemePenalty
  );
}

/**
 * The single quote a VOC theme should show, or null when the whole pool is
 * fragments and adverts — no quote beats a quote that says nothing. Ties break
 * on stored order, so evidence order still decides between equals.
 */
export function pickVocVerbatim(
  quotes: unknown,
  label?: string | null,
  minScore: number = MIN_VOC_VERBATIM_SCORE,
): string | null {
  if (!Array.isArray(quotes)) return null;
  let best: string | null = null;
  let bestScore = minScore;
  for (const quote of quotes) {
    if (typeof quote !== 'string') continue;
    const score = scoreVocVerbatim(quote, label);
    if (score > bestScore) {
      best = quote;
      bestScore = score;
    }
  }
  return best;
}

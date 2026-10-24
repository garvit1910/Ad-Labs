/**
 * Pure ranking for the verbatim shown on a persona card — PURE, no IO.
 *
 * Persona synthesis is allowed to attach any pack-supplied quote to a persona,
 * and the card rendered `verbatims[0]` — model order, which is not quality
 * order. On Magic Spoon prod the "Dietary-Safe Convenience Seeker" card led
 * with "The marshmallow cereal is NOT gluten free!!" — a product-defect
 * callout, not a portrait of the buyer — while the line that actually shows
 * who that person is ("for someone who can't eat sugary stuff, this is
 * perfection … I can finally eat cereal again") sat last in the array.
 *
 * A persona verbatim earns its place by showing the CUSTOMER: their situation,
 * need, or verdict in their own voice. Negative sentiment is fine — a burned
 * ex-customer persona is made of negative quotes — what disqualifies a line is
 * that it is aimed AT the brand (shipping inquiries, feature requests,
 * warn-others accusations, shouty defect callouts) instead of describing the
 * person saying it.
 *
 * Read-time scoring over stored text: no re-synthesis and no schema change, so
 * it re-ranks every persona already in the DB. `validatePersonas` also orders
 * newly stored verbatims by the same score, which keeps the retrieval chunk's
 * "best verbatim" (chunks.ts takes the first evidence quote) in agreement.
 */

import { isQuoteInMerchantLanguage } from '../quote-language';

/** Persona quotes carry situation, so the band runs longer than an ad hook. */
const IDEAL_MIN = 30;
const IDEAL_MAX = 200;
/** Below this a line is a fragment; above it a wall of text in a small card. */
const HARD_MIN = 12;
const HARD_MAX = 320;

/** Below this the best line is worse than no line — the card omits it. */
export const MIN_PERSONA_VERBATIM_SCORE = 0.3;

const FIRST_PERSON_RE =
  /\b(i|i['’]?m|i['’]?ve|i['’]?d|i['’]?ll|my|me|mine|we|we['’]?re|our|us)\b/i;
/**
 * Self-identification only counts when it OPENS the line ("As a diabetic I…",
 * "for someone who can't eat sugary stuff…"). Mid-sentence "as a" is almost
 * always a use-case, not an identity ("Love this as a snack").
 */
const SELF_ID_RE = /^\W*(as an? |for (someone|people|those|anyone) who\b)/i;

/** '?' anywhere, a leading wh-word, or leading aux-inversion ("do you …"). */
const WH_INITIAL_RE = /^(?:\W*\w+[\s,]+)?(what|why|when|where|how|which|who)\b/i;
const AUX_INVERSION_RE =
  /^(?:\W*\w+[\s,]+)?(do|does|did|can|could|will|would|should|are|is|was|have|has|any)\s+(you|u|i|we|they|it|this|these|those|there|any|the|your)\b/i;

/** Asking the brand for something rather than describing oneself. */
const REQUEST_RE = /\b(please|pls|can you|could you|would you|will you)\b/i;
const SECOND_PERSON_RE = /\b(you|your|yours|u|ur|y['’]?all)\b/i;

/**
 * Warning other shoppers off / accusing the brand. Distinct from a customer
 * reporting their own bad experience, which stays eligible.
 */
const WARN_OTHERS_RE =
  /\b(scam|fraud|liars?|lying|false advertis\w*|misleading|rip[-\s]?off|don['’]?t bother|do not buy|don['’]?t buy|beware|be aware|boycott|stay away|shame on|is a con)\b/i;

/** Shouted words read as a complaint headline, not a person talking. */
const SHOUT_RE = /\b[A-Z]{3,}\b/;

/** Length score: 1 across the ideal band, tapering to 0 at the hard bounds. */
function lengthScore(len: number): number {
  if (len >= IDEAL_MIN && len <= IDEAL_MAX) return 1;
  if (len < IDEAL_MIN) {
    return Math.max(0, (len - HARD_MIN) / (IDEAL_MIN - HARD_MIN));
  }
  return Math.max(0, (HARD_MAX - len) / (HARD_MAX - IDEAL_MAX));
}

/** Too short, too long, or too little prose to portray anyone. */
export function isDisqualifiedPersonaVerbatim(quote: string): boolean {
  const trimmed = quote.trim();
  if (trimmed.length < HARD_MIN || trimmed.length > HARD_MAX) return true;
  // A persona in an English report is not portrayed by a Japanese tweet.
  if (!isQuoteInMerchantLanguage(trimmed)) return true;
  const letters = trimmed.replace(/[^\p{L}]/gu, '').length;
  if (letters < 10 || letters / trimmed.length < 0.45) return true;
  return false;
}

function isInterrogative(quote: string): boolean {
  return (
    quote.includes('?') || WH_INITIAL_RE.test(quote) || AUX_INVERSION_RE.test(quote)
  );
}

/**
 * Higher = more representative of the persona. Disqualified lines score 0.
 * Customer voice and a card-sized length carry the base; the multipliers strip
 * out lines addressed to the brand instead of about the buyer.
 */
export function scorePersonaVerbatim(quote: string): number {
  const trimmed = quote.trim();
  if (isDisqualifiedPersonaVerbatim(trimmed)) return 0;

  const selfVoice =
    FIRST_PERSON_RE.test(trimmed) || SELF_ID_RE.test(trimmed) ? 1 : 0;
  const base = 0.55 * selfVoice + 0.45 * lengthScore(trimmed.length);

  const interrogative = isInterrogative(trimmed);
  const questionPenalty = interrogative ? 0.35 : 1;

  // Second person only counts against a line when it is asking the brand for
  // something — "until I saw who you sponsored" is still the buyer talking.
  const addressesBrand =
    SECOND_PERSON_RE.test(trimmed) && (interrogative || REQUEST_RE.test(trimmed));
  const brandDirectedPenalty = addressesBrand ? 0.45 : 1;

  const warnPenalty = WARN_OTHERS_RE.test(trimmed) ? 0.5 : 1;
  const shoutPenalty = SHOUT_RE.test(trimmed) ? 0.6 : 1;
  const exclaimPenalty = (trimmed.match(/!/g) ?? []).length >= 2 ? 0.75 : 1;

  return (
    base *
    questionPenalty *
    brandDirectedPenalty *
    warnPenalty *
    shoutPenalty *
    exclaimPenalty
  );
}

/**
 * Order best-first WITHOUT dropping anything — verbatims are stored evidence,
 * so a weak line stays in the array, it just stops leading it. Stable within
 * equal scores by input order, so the model's own ordering breaks ties.
 */
export function rankPersonaVerbatims(quotes: string[]): string[] {
  return quotes
    .map((quote, index) => ({ quote, index, score: scorePersonaVerbatim(quote) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.quote);
}

/**
 * Normalized identity for a displayed verbatim — case/whitespace/terminal
 * punctuation folded away so two personas whose pools carry the "same" quote in
 * cosmetically different form still collide. Used to enforce one-quote-per-card
 * across a persona set (see `personaCards`); the ladder must never print the
 * same line under two awareness stages.
 */
export function personaVerbatimKey(quote: string): string {
  return quote
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .toLowerCase();
}

/**
 * The single quote a persona card should show, or null when the whole pool is
 * brand-directed noise — an empty quote line beats a misrepresentative one.
 *
 * `claimed` holds the `personaVerbatimKey`s already spoken for by earlier
 * cards. A quote in that set is skipped even when it is this persona's
 * strongest line, so a verbatim shared across two personas' pools lands on only
 * the first and the second falls through to its best UNCLAIMED line (or null).
 */
export function pickPersonaVerbatim(
  quotes: unknown,
  claimed?: ReadonlySet<string>,
): string | null {
  if (!Array.isArray(quotes)) return null;
  const strings = quotes.filter(
    (quote): quote is string => typeof quote === 'string',
  );
  let best: string | null = null;
  let bestScore = MIN_PERSONA_VERBATIM_SCORE;
  for (const quote of strings) {
    if (claimed?.has(personaVerbatimKey(quote))) continue;
    const score = scorePersonaVerbatim(quote);
    if (score > bestScore) {
      best = quote;
      bestScore = score;
    }
  }
  return best;
}

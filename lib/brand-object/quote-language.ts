/**
 * The merchant-language gate for customer quotes — PURE, no IO, client-safe.
 *
 * Brand listening pulls mentions from platforms that carry every language a
 * brand's customers write in, and the relevance filter keeps a mention that is
 * genuinely about the brand whatever language it is in. That is right for the
 * counts, and wrong for the QUOTES: the Bee Inspired Brand Book (2026-09-11)
 * headlined its projected persona with a Japanese tweet ("グレー、白、黒のT
 * シャツ以外も着ようと思う今日この頃。") and printed a Dutch review
 * ("Slechtste retour service ooit gezien!") under Objections. A reader of an
 * English report cannot use either, and the print renderer has no font for
 * the first. A quote is only shown in the merchant's language.
 *
 * MERCHANT LANGUAGE: no organization or brand profile stores one yet. The
 * whole pipeline is English by configuration (actor `language: 'en'`, the
 * website fetch asks for `en-US`), so the gate defaults to English through
 * `MERCHANT_LANGUAGE_DEFAULT`. Every caller passes through this module, so a
 * per-org language becomes a one-line change here plus a field — not a hunt.
 *
 * DETECTION is deliberately dependency-free and tuned for review-length text:
 * (1) script — the letters must be overwhelmingly Latin (this alone rejects
 * CJK, Cyrillic, Arabic, Thai …); (2) vocabulary — a quote of four or more
 * words must draw on common English (function words plus everyday review
 * vocabulary) for a real share of its tokens. Two- and three-word quotes are
 * too short to judge and pass on script alone ("Great clothes 👏👏👏💚",
 * "heavy good, dead fancy"). A Dutch line with two English loanwords can still
 * slip through; a false reject of real English is the costlier error, so the
 * thresholds lean permissive.
 */

export type MerchantLanguage = 'en';

/** See the module note: the pipeline is English by configuration today. */
export const MERCHANT_LANGUAGE_DEFAULT: MerchantLanguage = 'en';

/** Share of letters that must be Latin script. */
const LATIN_SHARE_MIN = 0.8;
/** Below this many words a quote passes on script alone. */
const MIN_WORDS_TO_JUDGE = 4;
/**
 * Common-English hits required, absolute and as a share of the words. A
 * four- or five-word line gets the looser bar: "heavy good, dead fancy" is
 * English with one common word in it, while a Dutch review of that length
 * with one English loanword ("service") still sits under a quarter.
 */
const SHORT_LINE_WORDS = 5;
const SHORT_HITS_MIN = 1;
const SHORT_SHARE_MIN = 0.25;
const ENGLISH_HITS_MIN = 2;
const ENGLISH_SHARE_MIN = 0.3;

/**
 * Function words, contractions (apostrophes stripped) and the everyday
 * vocabulary of product reviews and social comments. Coverage, not an
 * exhaustive dictionary: a real English sentence of four-plus words nearly
 * always carries two of these.
 */
const COMMON_ENGLISH = new Set(
  (
    'the a an and or but so if then than that this these those there here ' +
    'is are was were be been being am do does did done have has had having ' +
    'will would can could should shall may might must to of in on at for ' +
    'with from by as it its my me mine you your yours we our us they them ' +
    'their he she his her him not no yes very just too all any some out up ' +
    'down about into over under after before again more most less least ' +
    'much many few other another such only own same both each every either ' +
    'neither because while when where why how what which who whom whose ' +
    'i im ive id ill youre theyre weve were dont didnt doesnt isnt wasnt ' +
    'arent cant couldnt wouldnt shouldnt wont havent hasnt thats whats ' +
    'lets gonna wanna gotta lol tbh omg btw pls plz ' +
    'good great bad nice love loved loving like liked really pretty quite ' +
    'super well best better worst worse amazing awesome brilliant excellent ' +
    'perfect poor terrible horrible awful decent fine ok okay happy sad ' +
    'quality price prices pricey cheap expensive value money worth cost ' +
    'delivery delivered deliver shipping shipped arrive arrived arrives ' +
    'order ordered ordering return returned returns refund refunded refunds ' +
    'item items product products stuff thing things brand shop store site ' +
    'website online buy bought buying purchase purchased pay paid got get ' +
    'getting received receive customer service support email emails reply ' +
    'replied replies contact waiting wait waited still never always ever ' +
    'again back new old first last next time times day days week weeks ' +
    'month months year years ago now today soon quick quickly fast slow ' +
    'late early size sizes sizing small big large fit fits fitted fitting ' +
    'wear wearing wore look looks looked looking feel feels felt comfy ' +
    'comfortable clothes clothing top tops shirt tshirt tee tees hoodie ' +
    'jacket jumper jeans trousers cargos trainers shoes pair colour color ' +
    'design designs style stylish material fabric made make makes making ' +
    'work works worked working use used using want wants wanted need needs ' +
    'needed think thought know knew see seen saw say said tell told try ' +
    'tried come came go went keep kept take took give gave find found put ' +
    'people guys man men boy son kids friend family home house life ' +
    'one two three four five ten lot lots bit little long short high low ' +
    'right wrong sure easy hard hope please thanks thank recommend definitely ' +
    'absolutely honestly actually probably maybe also even only already yet ' +
    'fancy dead proper mate deffo lush sound decent class quid'
  )
    .split(/\s+/)
    .filter(Boolean),
);

const LETTER_RE = /\p{L}/gu;
const LATIN_LETTER_RE = /\p{Script=Latin}/gu;
/** Handles, hashtags and links are not words in any language. */
const NOISE_TOKEN_RE = /(^|\s)([@#]\S+|https?:\/\/\S+|www\.\S+)/giu;
const WORD_RE = /\p{Script=Latin}+/gu;

/** True when the quote's letters are overwhelmingly Latin script. */
export function isLatinScript(text: string): boolean {
  const letters = text.match(LETTER_RE)?.length ?? 0;
  if (letters === 0) return true;
  const latin = text.match(LATIN_LETTER_RE)?.length ?? 0;
  return latin / letters >= LATIN_SHARE_MIN;
}

function englishWords(text: string): string[] {
  return (
    text
      .replace(NOISE_TOKEN_RE, ' ')
      .replace(/['’]/g, '')
      .toLowerCase()
      .match(WORD_RE) ?? []
  );
}

/**
 * True when a customer quote is in the merchant's language and may be shown,
 * quoted, or handed to a model as evidence. Empty text passes — there is
 * nothing to misjudge, and callers gate length separately.
 */
export function isQuoteInMerchantLanguage(
  quote: string,
  language: MerchantLanguage = MERCHANT_LANGUAGE_DEFAULT,
): boolean {
  if (language !== 'en') return true;
  if (!isLatinScript(quote)) return false;
  const words = englishWords(quote);
  if (words.length < MIN_WORDS_TO_JUDGE) return true;
  const hits = words.filter((word) => COMMON_ENGLISH.has(word)).length;
  const share = hits / words.length;
  if (words.length <= SHORT_LINE_WORDS) {
    return hits >= SHORT_HITS_MIN && share >= SHORT_SHARE_MIN;
  }
  return hits >= ENGLISH_HITS_MIN && share >= ENGLISH_SHARE_MIN;
}

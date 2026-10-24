/**
 * Pure hook-worthiness ranking for the Insights "Hook-worthy" strip.
 *
 * The extraction pass pulls 0-3 verbatim quotes from EVERY kept mention, so the
 * quote pool is dominated by filler: brand-caption engagement bait ("Which
 * flavor would you pick up?"), friend tags ("@dani tienes q probar…"), bare
 * one-word/emoji reactions ("Delicious 🤤"), and rambling run-ons. The strip
 * used to render the 3 most RECENTLY extracted quotes, which surfaced exactly
 * that filler. This ranks a recent candidate window by how well each line would
 * work as an ad hook so the genuinely punchy customer-voice lines float up.
 *
 * Signals are all read-time from stored columns (phrase text + numeric
 * sentiment) — no re-extraction and no schema change — so it re-ranks the
 * existing corpus immediately. Pure and unit-tested; the route only slices.
 */

export interface HookQuoteCandidate {
  phrase: string;
  /** -1..1 numeric sentiment carried on the quote's phrase row (nullable). */
  sentiment: number | null;
}

/** Ideal hook length band (chars). Punchy enough to read as a hook, long
 * enough to carry a specific claim — tuned against real VOC quotes. */
const IDEAL_MIN = 24;
const IDEAL_MAX = 130;
/** Below this a line is a bare reaction; above it a rambling paragraph. */
const HARD_MIN = 12;
const HARD_MAX = 240;

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/**
 * A hook has to be a customer SAYING something, not a caption, tag, or emoji.
 * These are hard excludes — they can never rank, regardless of sentiment.
 */
export function isDisqualifiedHookQuote(phrase: string): boolean {
  const trimmed = phrase.trim();
  if (trimmed.length < HARD_MIN || trimmed.length > HARD_MAX) return true;
  // Friend tags / mention chains ("@dani tienes q probar…").
  if (trimmed.startsWith('@')) return true;
  // Letters carry the message; emoji and punctuation do not. Require real prose
  // density so "😍😋👌🏻🔥🔥🔥" and "Good grades ❌ Shitty jacket ✅" drop out.
  const letters = trimmed.replace(/[^\p{L}]/gu, '').length;
  if (letters < 12 || letters / trimmed.length < 0.45) return true;
  // Handle-dominated (mostly @mentions) — a re-tag, not a testimonial.
  const handles = (trimmed.match(/@\w/g) ?? []).length;
  if (handles >= 2) return true;
  return false;
}

/** Length score: 1 across the ideal band, tapering to 0 at the hard bounds. */
function lengthScore(len: number): number {
  if (len >= IDEAL_MIN && len <= IDEAL_MAX) return 1;
  if (len < IDEAL_MIN) return Math.max(0, (len - HARD_MIN) / (IDEAL_MIN - HARD_MIN));
  return Math.max(0, (HARD_MAX - len) / (HARD_MAX - IDEAL_MAX));
}

/**
 * Higher = more hook-worthy. Disqualified quotes score 0. The dominant signal
 * is sentiment magnitude (hooks carry strong feeling — love or hate), shaped by
 * a length-band fit and a first-person "customer voice" nudge, and penalized
 * for engagement-bait questions.
 */
export function scoreHookQuote(candidate: HookQuoteCandidate): number {
  const phrase = candidate.phrase.trim();
  if (isDisqualifiedHookQuote(phrase)) return 0;

  const magnitude = Math.min(1, Math.abs(candidate.sentiment ?? 0));
  // Floor so a strong, specific neutral-scored line ("it tastes just like the
  // real thing") is not zeroed purely for lacking a sentiment reading.
  const sentimentScore = 0.35 + 0.65 * magnitude;

  const length = lengthScore(phrase.length);

  // First-person testimony reads as customer voice ("I made the ice cream bar
  // and it tasted delicious") vs. a detached caption.
  const firstPerson = /\b(i|i'?m|i'?ve|my|me|we|our)\b/i.test(phrase) ? 1 : 0;

  // Questions are almost always brand engagement-bait, not a customer claim.
  const questionPenalty = phrase.endsWith('?') ? 0.55 : 1;

  const emojiCount = (phrase.match(EMOJI_RE) ?? []).length;
  // A little emoji is fine; a pile of it is a reaction, not a hook.
  const emojiPenalty = emojiCount >= 4 ? 0.75 : 1;

  return (
    (0.6 * sentimentScore + 0.3 * length + 0.1 * firstPerson) *
    questionPenalty *
    emojiPenalty
  );
}

/**
 * Rank a candidate pool best-first and return the top `limit`, dropping the
 * disqualified. Stable within equal scores by preserving input order (callers
 * pass a most-recent-first window, so ties break toward fresher quotes).
 */
export function rankHookQuotes<T extends HookQuoteCandidate>(
  candidates: T[],
  limit: number,
): T[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreHookQuote(candidate),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

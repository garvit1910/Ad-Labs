/**
 * Deterministic copy-grounding guards — the ONE implementation. Moved here
 * from `generation/copy-guards.ts` (2026-10-01) so the client-safe brand
 * check can share it; `copy-guards.ts` (and through it `brand-copy.ts`)
 * re-exports both functions, so every existing import path keeps working.
 *
 * ZERO imports beyond this directory — client-safe.
 */
import { BANNED_AD_SPEAK } from './banned-ad-speak';

const NUMERAL_RE = /\d[\d,.]*/g;

/**
 * One spelling per numeral: a trailing sentence `.`/`,` is dropped, then the
 * thousands commas. The decimal point stays, so "4.7" and "47" differ.
 */
function normalizeNumeral(token: string): string {
  return token.replace(/[,.]+$/u, '').replace(/,/gu, '');
}

/**
 * Every digit sequence in the copy must appear as a WHOLE numeral (comma-
 * normalized) in the grounding text (the pack-rendered user prompt: facts,
 * persona verbatims, rules, angle). "13g protein" needs a fact containing 13 —
 * an LLM that invents a quantity fails here deterministically. Whole-number
 * matching (Ad Lab): "30" does not ground on "3,000" or "130", while "4.7"
 * still grounds on "4.7 out of 5" and "3,000" on "3000".
 */
export function findUngroundedNumerals(
  copy: { headline: string; primaryText: string },
  groundingText: string,
): string[] {
  const grounded = new Set(
    (groundingText.match(NUMERAL_RE) ?? []).map(normalizeNumeral),
  );
  const violations: string[] = [];
  const tokens = `${copy.headline} ${copy.primaryText}`.match(NUMERAL_RE) ?? [];
  for (const token of tokens) {
    const normalized = normalizeNumeral(token);
    if (normalized.length === 0) continue;
    if (!grounded.has(normalized) && !violations.includes(token)) {
      violations.push(token);
    }
  }
  return violations;
}

/** Case-insensitive substring scan over the shared BANNED_AD_SPEAK list. */
export function findBannedPhrases(copy: {
  headline: string;
  primaryText: string;
}): string[] {
  const haystack = `${copy.headline} ${copy.primaryText}`.toLowerCase();
  return BANNED_AD_SPEAK.filter((phrase) => haystack.includes(phrase));
}

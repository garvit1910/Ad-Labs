/**
 * The deterministic brand-rule matchers — the ONE implementation shared by
 * the generation gates (`generation/gates.ts runGates`) and the stateless
 * brand check (`runBrandCheck`). Extracted from gates.ts byte-for-byte: the
 * gate keeps its own GateResult shaping (and the disclaimer gate's
 * `disclaimerRendered` branch), these functions only answer "which rules
 * matched".
 *
 * ZERO imports — client-safe (a `'use client'` component reaches this through
 * the brand-check barrel).
 */

/** Escape a literal for safe use inside a RegExp source. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prohibited claims — case-insensitive SUBSTRING match over the haystack.
 * Returns the matching claims in rule order (as written, untrimmed).
 */
export function findProhibitedClaims(
  haystack: string,
  prohibitedClaims: readonly string[]
): string[] {
  const haystackLower = haystack.toLowerCase();
  return prohibitedClaims.filter(
    (claim) => claim.trim().length > 0 && haystackLower.includes(claim.toLowerCase())
  );
}

/** The required disclaimers that carry content (blank entries dropped). */
export function activeDisclaimers(requiredDisclaimers: readonly string[]): string[] {
  return requiredDisclaimers.filter((disclaimer) => disclaimer.trim().length > 0);
}

/**
 * Required disclaimers — VERBATIM (case-sensitive) string presence. Returns
 * the non-empty disclaimers missing from the haystack, in rule order.
 */
export function findMissingDisclaimers(
  haystack: string,
  requiredDisclaimers: readonly string[]
): string[] {
  return activeDisclaimers(requiredDisclaimers).filter(
    (disclaimer) => !haystack.includes(disclaimer)
  );
}

/**
 * Brand-lexicon avoid words — case-insensitive WORD-BOUNDARY match of the
 * trimmed word. Returns the matching entries in rule order (as written).
 */
export function findLexiconHits(haystack: string, avoidWords: readonly string[]): string[] {
  return avoidWords.filter(
    (word) =>
      word.trim().length > 0 &&
      new RegExp(`\\b${escapeRegExp(word.trim())}\\b`, 'i').test(haystack)
  );
}

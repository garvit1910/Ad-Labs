/**
 * Execution-notes sanitizer — PURE, deterministic. Defense-in-depth behind
 * the labeler prompt's own "never name brands" instruction: before a winning
 * ad's staging notes ride a market_prior fact (and from there the generation
 * prompt), every known competitor/page/advertiser name is scrubbed at WRITE
 * time. Names the org does not track (a third brand mentioned in passing)
 * are the prompt instruction's job — documented v1 residual.
 */

const REPLACEMENT = 'the brand';
const MIN_RESIDUE_LENGTH = 10;
const MIN_NAME_LENGTH = 3;
/** Trailing legal suffixes stripped to widen matching (Bee Inspired Inc → Bee Inspired). */
const LEGAL_SUFFIX = /\s+(?:inc|llc|ltd|co|corp|gmbh|plc)\.?$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Name variants worth matching: raw, legal-suffix-stripped, punctuation-flattened. */
function nameVariants(name: string): string[] {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME_LENGTH) return [];
  const variants = new Set<string>([trimmed]);
  const withoutSuffix = trimmed.replace(LEGAL_SUFFIX, '').trim();
  if (withoutSuffix.length >= MIN_NAME_LENGTH) variants.add(withoutSuffix);
  const flattened = trimmed.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (flattened.length >= MIN_NAME_LENGTH) variants.add(flattened);
  return [...variants];
}

/**
 * Scrub URLs, @handles, and every forbidden name (whole word/phrase,
 * case-insensitive, possessive-aware) from a winning ad's execution notes.
 * Returns null when the residue is too short to carry staging signal —
 * over-stripped notes must vanish, never ship as fragments.
 */
export function sanitizeExecutionNotes(
  raw: string,
  forbiddenNames: readonly string[],
): string | null {
  let notes = raw
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/@[\p{L}\p{N}_.]+/gu, ' ');

  // Longest variants first so "Bee Inspired Clothing" is scrubbed before
  // "Bee Inspired" can leave a partial behind.
  const variants = [...new Set(forbiddenNames.flatMap(nameVariants))].sort(
    (a, b) => b.length - a.length,
  );
  for (const variant of variants) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(variant).replace(/ /g, '\\s+')}(?:['’]s)?(?![\\p{L}\\p{N}])`,
      'giu',
    );
    notes = notes.replace(pattern, REPLACEMENT);
  }

  // Collapse doubled replacements/whitespace and dangling space-before-punct.
  notes = notes
    .replace(new RegExp(`(?:${REPLACEMENT}\\s+)+${REPLACEMENT}`, 'g'), REPLACEMENT)
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return notes.length >= MIN_RESIDUE_LENGTH ? notes : null;
}

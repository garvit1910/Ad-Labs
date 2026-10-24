/**
 * Google Ads ad-text length (client-safe, zero imports). Google counts a
 * double-width character (Chinese, Japanese, Korean, full-width forms) as 2
 * toward every ad-text limit. Proven live 2026-10-22 (section H, H-F10): a
 * 16-character Japanese RSA headline (counter 16/30) was refused
 * `Too long. (ad.responsive_search_ad.headlines[0].text)`.
 *
 * Every other character keeps its UTF-16 length (what `.length` and the
 * counters used before), so only double-width text counts differently.
 * Applies to ad text (headlines, descriptions, business names, paths,
 * extension text), not to entity names or URLs.
 */

// East Asian Wide and Fullwidth blocks: Hangul Jamo, CJK radicals/symbols,
// Hiragana, Katakana, CJK ideographs (incl. extension A and compatibility),
// Yi, Hangul syllables, CJK compatibility forms, full-width forms and signs,
// and the supplementary ideograph planes.
const DOUBLE_WIDTH =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;

export function googleAdTextLength(text: string | null | undefined): number {
  if (!text) return 0;
  let length = 0;
  for (const character of text) {
    length += DOUBLE_WIDTH.test(character) ? 2 : character.length;
  }
  return length;
}

export function fitsGoogleAdTextLimit(text: string | null | undefined, max: number): boolean {
  return googleAdTextLength(text) <= max;
}

/** Contract refinement for an ad-text field: `.refine(...googleAdTextRefinement(30))`. */
export function googleAdTextRefinement(max: number): [
  (_value: string) => boolean,
  string,
] {
  return [
    (value: string) => fitsGoogleAdTextLimit(value, max),
    `Must be ${max} characters or fewer (Chinese, Japanese and Korean characters count as 2)`,
  ];
}

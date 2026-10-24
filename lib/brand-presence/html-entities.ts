/**
 * Decodes the HTML entities scrapers leave in user text. Reddit's JSON
 * HTML-escapes post and comment bodies (`I&#39;ve`, `&quot;food&quot;`,
 * `&#32;`) and X escapes `&`, `<` and `>`, so without this the raw escapes
 * render in the feed. Client-safe, zero imports.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const ENTITY_PATTERN = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;

function decodeCodePoint(raw: string, radix: number): string | null {
  const codePoint = Number.parseInt(raw, radix);
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
    return null;
  }
  return String.fromCodePoint(codePoint);
}

function decodeOnce(text: string): string {
  return text.replace(ENTITY_PATTERN, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const decoded = decodeCodePoint(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return decoded ?? match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Decodes entities, including a double-escaped `&amp;#39;` (Reddit escapes
 * already-escaped text). Two passes at most, so the work stays bounded.
 */
export function decodeHtmlEntities<T extends string | null>(text: T): T {
  if (text === null || !text.includes('&')) return text;
  const once = decodeOnce(text);
  return (once.includes('&') ? decodeOnce(once) : once) as T;
}

/** Decodes the display text fields of a stored mention row. */
export function decodeMentionText<
  T extends { title?: string | null; body?: string | null; parent_title?: string | null },
>(mention: T): T {
  return {
    ...mention,
    ...(mention.title !== undefined && { title: decodeHtmlEntities(mention.title) }),
    ...(mention.body !== undefined && { body: decodeHtmlEntities(mention.body) }),
    ...(mention.parent_title !== undefined && {
      parent_title: decodeHtmlEntities(mention.parent_title),
    }),
  };
}

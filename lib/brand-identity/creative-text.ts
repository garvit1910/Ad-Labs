/**
 * Shared handling for scraped creative copy that is nothing but an unrendered
 * feed template token, e.g. "{{product.brand}}", "{{product.name}}".
 *
 * Google's Ads Transparency Center exposes the TEMPLATE for feed-driven ads
 * (Performance Max / Shopping / dynamic), not the resolved per-product values,
 * so we scrape literal `{{...}}` tokens. We can't resolve them (no access to the
 * competitor's product feed), so they read as broken UI — strip them from any
 * user-facing copy surface and from label/cluster selection.
 */

/** Matches every {{...}} product-bind token in a string. */
const TEMPLATE_TOKEN = /\{\{[^}]*\}\}/g;

/** True when a string, trimmed, is a single unrendered template token. */
export function isTemplateOnly(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  return !!trimmed && /^\{\{[^}]*\}\}$/.test(trimmed);
}

/** Keeps only entries with real copy — drops blanks and template-only tokens.
 *  Strip-only: used by internal analytics (cluster labels), which must not inject
 *  a brand name into what is meant to be verbatim ad copy. UI surfaces should use
 *  `resolveCopyList` instead so the reader sees a value, not a dropped line. */
export function realCopyOnly(list: string[] | null | undefined): string[] {
  return (list ?? []).filter((raw) => {
    const trimmed = raw?.trim();
    return !!trimmed && !isTemplateOnly(trimmed);
  });
}

/** First entry that carries real copy, or null when every entry is noise. */
export function firstRealBody(bodies: string[] | null | undefined): string | null {
  return realCopyOnly(bodies)[0]?.trim() ?? null;
}

/**
 * Replace every {{...}} product-bind token with the competitor's page name.
 * Feed-driven Google ads scrape as unresolved templates and we can't read the
 * competitor's product feed, so the brand/page name is the closest real value.
 * When no page name is known the token is dropped. Returns the cleaned copy, or
 * null when nothing meaningful remains.
 */
export function resolveProductBinds(
  text: string | null | undefined,
  pageName: string | null | undefined
): string | null {
  const raw = text?.trim();
  if (!raw) return null;
  const fallback = pageName?.trim() ?? '';
  const resolved = raw
    .replace(TEMPLATE_TOKEN, fallback)
    .replace(/[ \t]{2,}/g, ' ') // tidy gaps a dropped token leaves; keep newlines
    .trim();
  return resolved || null;
}

/**
 * Resolve a list of copy entries against the page name, dropping blanks and
 * de-duplicating. Dedup matters because sibling tokens (`{{product.name}}` +
 * `{{product.description}}`) both resolve to the same page name and would
 * otherwise render as duplicate chips.
 */
export function resolveCopyList(
  list: string[] | null | undefined,
  pageName: string | null | undefined
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of list ?? []) {
    const resolved = resolveProductBinds(entry, pageName);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** First entry with real or page-name-resolved copy, or null when none remains. */
export function firstResolvedBody(
  list: string[] | null | undefined,
  pageName: string | null | undefined
): string | null {
  return resolveCopyList(list, pageName)[0] ?? null;
}

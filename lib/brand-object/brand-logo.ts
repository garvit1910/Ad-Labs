/**
 * Derive a brand's logo mark from its website URL. The brand build does not
 * capture a logo asset, so the founder's `website_url` is the only anchor we
 * have — we resolve the site's favicon (which is almost always the brand mark
 * shown in the browser tab) through Google's favicon service at a size large
 * enough to render as an avatar. Callers render this with an initial-letter
 * fallback (see `OrgAvatar`) so a missing/broken icon never blanks the header.
 */

/** Pull a bare hostname from a possibly-protocol-less website URL. */
export function hostnameFromWebsite(
  websiteUrl: string | null | undefined,
): string | null {
  if (typeof websiteUrl !== 'string') return null;
  const trimmed = websiteUrl.trim();
  if (trimmed === '') return null;
  // `new URL` needs a protocol; add one when the founder saved a bare domain.
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const host = new URL(withProtocol).hostname.toLowerCase();
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * The brand logo URL to use in the identity header, or null when we can't
 * derive a hostname (the caller then falls back to the brand initial).
 * `sz=128` keeps the mark crisp at avatar sizes on high-DPI screens.
 */
export function brandLogoUrlFromWebsite(
  websiteUrl: string | null | undefined,
): string | null {
  const host = hostnameFromWebsite(websiteUrl);
  if (!host) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
    host,
  )}&sz=128`;
}

/**
 * Pure URL helpers for the Google Maps Reviews source (no network). The
 * founder pastes their listing URL; validation accepts the startUrl shapes
 * the compass~google-maps-reviews-scraper actor supports (/maps/place,
 * /maps/search, /maps/reviews, maps?cid=) plus share short links.
 * maps.app.goo.gl / goo.gl/maps links are NOT expanded server-side (SSRF
 * surface) — the maxReviews=1 resolve probe run is the validator; a dead link
 * surfaces as an error card, never a billable full scrape. share.google links
 * (the newer Share button) are the exception: they redirect to a Google
 * SEARCH knowledge-panel URL the actor cannot take, so the setup route
 * expands them through Google-owned share hops only
 * (`google-share-link.ts`) and maps the result via mapsUrlFromShareTarget.
 */

/** Hosts like google.com / www.google.co.uk / maps.google.de. */
const GOOGLE_HOST_PATTERN = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/;

const SHORT_LINK_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);

export function isGoogleMapsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();

  if (SHORT_LINK_HOSTS.has(host)) {
    // maps.app.goo.gl/<id> is always a Maps share link; goo.gl needs /maps/.
    return host === 'maps.app.goo.gl' || url.pathname.startsWith('/maps/');
  }

  if (!GOOGLE_HOST_PATTERN.test(host)) return false;
  const path = url.pathname;
  if (
    path.startsWith('/maps/place/') ||
    path.startsWith('/maps/search/') ||
    path.startsWith('/maps/reviews')
  ) {
    return true;
  }
  // Uncommon but actor-supported: google.com/maps?cid=123...
  return (
    (path === '/maps' || path === '/maps/') && url.searchParams.has('cid')
  );
}

/**
 * Best-effort place name from the /maps/place/<name>/ (or /maps/search/<name>/,
 * what an expanded share.google link becomes) path segment — the
 * degraded-confirmation fallback when the resolve probe returns no items
 * (zero-review listing). Null for short links / cid links.
 */
export function parsePlaceNameFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const match = /^\/maps\/(?:place|search)\/([^/]+)/.exec(url.pathname);
  if (!match) return null;
  try {
    const decoded = decodeURIComponent(match[1]).replace(/\+/g, ' ').trim();
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

/** share.google/<id> — the short link the current Google Share button emits. */
export function isGoogleShareLink(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname.toLowerCase() === 'share.google' &&
    url.pathname.length > 1
  );
}

/**
 * A redirect hop inside Google's share-link expansion: share.google/<id>, then
 * www.google.<tld>/share.google?q=<id>. The expander only ever fetches URLs
 * that pass this check, so it can never be pointed at a non-Google host.
 */
export function isGoogleShareHop(raw: string): boolean {
  if (isGoogleShareLink(raw)) return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    GOOGLE_HOST_PATTERN.test(url.hostname.toLowerCase()) &&
    url.pathname === '/share.google'
  );
}

/**
 * Where an expanded share.google link landed → an actor-supported Maps URL.
 * A Maps URL passes through unchanged. A Google Search knowledge-panel URL
 * (`/search?kgmid=…&q=<business name>`, what a shared listing resolves to)
 * becomes a Maps name search; the resolve probe + brand-name match decide
 * whether it is the founder's listing before anything auto-confirms. Null for
 * anything else.
 */
export function mapsUrlFromShareTarget(raw: string): string | null {
  if (isGoogleMapsUrl(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!GOOGLE_HOST_PATTERN.test(url.hostname.toLowerCase())) return null;
  if (url.pathname !== '/search') return null;
  const query = url.searchParams.get('q')?.trim();
  if (!query) return null;
  return `https://www.google.com/maps/search/${encodeURIComponent(query).replace(/%20/g, '+')}`;
}

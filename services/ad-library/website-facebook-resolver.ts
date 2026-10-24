/**
 * Resolves a brand's Facebook page from its website.
 *
 * A brand's homepage almost always links its Facebook page from a social icon
 * in the header or footer. `extractFacebookLinks` mines the raw HTML for those
 * links, discards share/login/plugin junk that isn't a brand page, normalizes
 * each survivor through {@link parsePageInput}, and returns ranked candidates
 * (best guess first). The caller then feeds the chosen candidate into the
 * existing competitor create + sync flow.
 *
 * `assertPublicHttpUrl` is the SSRF guard for the user-supplied website URL —
 * we fetch arbitrary user input server-side, so internal/private targets must
 * be rejected before any fetch.
 */

import { parsePageInput } from './page-input';

/** A Facebook page discovered on a website, normalized for the create flow. */
export interface FacebookPageCandidate {
  /** The first raw href we saw for this page (for display / manual override). */
  rawUrl: string;
  /** Vanity handle, when the link resolves to one (feeds `pageRef`). */
  handle: string | null;
  /** Numeric page id, when the link is a profile.php?id= / numeric link. */
  numericId: string | null;
}

/** Thrown for an unusable / disallowed website URL; mapped to a 400 by routes. */
export class WebsiteResolveError extends Error {
  readonly reason: string;
  readonly remediation: string;

  constructor(reason: string, remediation: string) {
    super(reason);
    this.name = 'WebsiteResolveError';
    this.reason = reason;
    this.remediation = remediation;
  }
}

/** Hosts that are Facebook infra, never a public brand page. */
const JUNK_HOST_RE = /^(?:developers|business|l|lm|m\.business|connect|apps|pixel)\./i;

/** First path segments that are Facebook features, not a brand page. */
const JUNK_FIRST_SEGMENT = new Set([
  'sharer',
  'share',
  'share.php',
  'dialog',
  'plugins',
  'tr',
  'tr.php',
  'login',
  'login.php',
  'help',
  'policy',
  'policies',
  'privacy',
  'terms',
  'legal',
  'groups',
  'events',
  'watch',
  'gaming',
  'marketplace',
  'login',
  'recover',
  'hashtag',
  'sharer.php',
]);

/** Matches an absolute or protocol-relative Facebook/fb URL anywhere in markup. */
const FB_URL_RE =
  /(?:https?:)?\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.me)\/[^\s"'<>)\\]*/gi;

function isFacebookHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'facebook.com' ||
    host.endsWith('.facebook.com') ||
    host === 'fb.com' ||
    host.endsWith('.fb.com') ||
    host === 'fb.me' ||
    host.endsWith('.fb.me')
  );
}

/**
 * Extracts ranked Facebook page candidates from raw website HTML.
 * Returns `[]` when no usable brand-page link is present.
 */
export function extractFacebookLinks(html: string): FacebookPageCandidate[] {
  if (!html) return [];

  const matches = html.match(FB_URL_RE) ?? [];

  // Aggregate per normalized identity so the same page linked twice (header +
  // footer) counts as one candidate but ranks higher.
  const byKey = new Map<
    string,
    { candidate: FacebookPageCandidate; count: number; depth: number }
  >();

  for (const rawMatch of matches) {
    // Normalize protocol-relative and scheme-less forms to an absolute URL.
    const withScheme = rawMatch.startsWith('//')
      ? `https:${rawMatch}`
      : rawMatch.startsWith('http')
        ? rawMatch
        : `https://${rawMatch}`;

    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      continue;
    }

    if (!isFacebookHost(url.hostname)) continue;
    if (JUNK_HOST_RE.test(url.hostname)) continue;

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) continue; // bare facebook.com, no page
    if (JUNK_FIRST_SEGMENT.has(segments[0].toLowerCase())) continue;

    // Reconstruct on the canonical facebook.com host so parsePageInput (which
    // only understands facebook.com) can resolve fb.com / fb.me links too.
    const canonical = `https://www.facebook.com${url.pathname}${url.search}`;
    const parsed = parsePageInput(canonical);
    if (!parsed || (!parsed.handle && !parsed.numericId)) continue;

    const key = parsed.numericId ? `id:${parsed.numericId}` : `handle:${parsed.handle}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, {
        candidate: {
          rawUrl: rawMatch.startsWith('http') ? rawMatch : withScheme,
          handle: parsed.handle,
          numericId: parsed.numericId,
        },
        count: 1,
        depth: segments.length,
      });
    }
  }

  // Rank: most-linked first, then shallowest path (a top-level vanity URL beats
  // a deep link), then shortest handle as a final tiebreaker.
  return [...byKey.values()]
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.depth !== b.depth) return a.depth - b.depth;
      const aLen = a.candidate.handle?.length ?? Number.MAX_SAFE_INTEGER;
      const bLen = b.candidate.handle?.length ?? Number.MAX_SAFE_INTEGER;
      return aLen - bLen;
    })
    .map((entry) => entry.candidate);
}

const PRIVATE_IPV4_RE =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * Validates a user-supplied website URL and rejects private / internal targets
 * before any server-side fetch. Returns the parsed URL on success.
 */
export function assertPublicHttpUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new WebsiteResolveError(
      'A website URL is required.',
      'Enter the brand’s website, e.g. https://uprootclean.com',
    );
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new WebsiteResolveError(
      'That does not look like a valid website URL.',
      'Enter a full URL, e.g. https://uprootclean.com',
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebsiteResolveError(
      'Only http(s) website URLs are supported.',
      'Enter an http or https URL, e.g. https://uprootclean.com',
    );
  }

  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host.startsWith('[') || // bare IPv6 literal — not a public website
    !host.includes('.') || // single-label internal host
    PRIVATE_IPV4_RE.test(host);

  if (isPrivate) {
    throw new WebsiteResolveError(
      'That host is not a public website.',
      'Enter a public brand website URL, e.g. https://uprootclean.com',
    );
  }

  return url;
}

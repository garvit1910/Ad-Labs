/**
 * Landing-domain extraction shared by both ad-library normalizers and the
 * raw-payload backfill script. The domain is the cheap deterministic key for
 * pairing the same real-world brand across platforms (Meta page ↔ Google
 * advertiser), so it must normalize identically everywhere.
 */

/**
 * Query params that carry the real destination inside a tracker/redirect
 * wrapper (`googleadservices.com/pagead/aclk?adurl=…`, `l.facebook.com/l.php?u=…`).
 * `URLSearchParams` already percent-decodes, so no extra decodeURIComponent
 * pass is needed — a second decode would corrupt targets whose own path
 * legitimately contains `%2F`.
 */
const REDIRECT_PARAMS = [
  'adurl',
  'u',
  'url',
  'dest',
  'destination',
  'redirect',
] as const;

/** Wrappers can nest (an ad server wrapping a link shortener); cap the walk. */
const MAX_UNWRAP_DEPTH = 2;

/**
 * Ad servers, social link-wrappers, and link hubs. A host in this set is never
 * a brand's landing domain: it is either a redirect that failed to unwrap or a
 * shared hub every advertiser can point at, so treating it as the brand key
 * would (a) make one wrapper the "dominant domain" of unrelated competitors —
 * and a 1:1 Meta/Google collision on it fabricates a cross-platform brand pair
 * — and (b) make shared wrapper paths (`/pagead/aclk`, `/l.php`) look like a
 * dedicated per-angle funnel. Matched on the exact host or any subdomain of it.
 */
const TRACKER_DOMAINS = [
  // Ad servers / click trackers
  'googleadservices.com',
  'googlesyndication.com',
  'doubleclick.net',
  'adclick.g.doubleclick.net',
  'go.microsoft.com',
  'clickserve.dartsearch.net',
  // Social link wrappers
  'l.facebook.com',
  'lm.facebook.com',
  'l.instagram.com',
  'l.messenger.com',
  'away.vk.com',
  't.umblr.com',
  // Link shorteners / link hubs
  'bit.ly',
  'tinyurl.com',
  't.co',
  'ow.ly',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'lnkd.in',
  'linktr.ee',
  'beacons.ai',
  'linkin.bio',
  'lnk.bio',
  'shorturl.at',
  'rb.gy',
  'msha.ke',
  'stan.store',
] as const;

/** True when `host` is a tracker/link-hub domain or a subdomain of one. */
export function isTrackerDomain(host: string | null | undefined): boolean {
  if (!host) return false;
  const bare = host.toLowerCase().replace(/^www\./, '');
  return TRACKER_DOMAINS.some(
    (domain) => bare === domain || bare.endsWith(`.${domain}`)
  );
}

/** Parses `value` as a URL, tolerating a bare hostname. Null when unparseable. */
function parseLoose(value: string): URL | null {
  try {
    // URL() needs a protocol; bare domains ("www.yesstyle.com") get one.
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? value
      : `https://${value}`;
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

/** One unwrap step: the first redirect param holding an absolute http(s) URL. */
function redirectTarget(value: string): string | null {
  const url = parseLoose(value);
  if (!url) return null;
  for (const param of REDIRECT_PARAMS) {
    const candidate = url.searchParams.get(param);
    if (!candidate) continue;
    // Only an absolute http(s) target is a destination; a relative or opaque
    // value belongs to the wrapper's own routing.
    if (!/^https?:\/\//i.test(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Resolves a tracker/redirect wrapper to the destination it points at, e.g.
 * `https://www.googleadservices.com/pagead/aclk?adurl=https://real.com/p` →
 * `https://real.com/p`. Returns the input unchanged when there is nothing to
 * unwrap, so it is safe to call on every URL.
 */
export function unwrapRedirectUrl(value: string): string {
  let current = value;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const next = redirectTarget(current);
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * Extracts a lowercase registrable-ish domain from a full URL or a bare
 * display domain (Meta's `snapshot.caption` is e.g. "www.yesstyle.com").
 * Unwraps tracker/redirect wrappers first, strips protocol, `www.`, port,
 * path, query, and fragment. Returns null for anything that doesn't look like
 * a hostname, and for a tracker/link-hub host that survived unwrapping (it
 * identifies no brand — see TRACKER_DOMAINS).
 */
export function extractLandingDomain(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;

  const url = parseLoose(unwrapRedirectUrl(trimmed));
  if (!url) return null;

  const host = url.hostname.replace(/^www\./, '');
  // A real hostname has at least one dot and no spaces; this drops junk like
  // display captions that are marketing copy rather than a domain.
  if (!host.includes('.') || /\s/.test(host)) return null;
  if (isTrackerDomain(host)) return null;
  return host;
}

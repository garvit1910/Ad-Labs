/**
 * Parses whatever a user pastes to identify a competitor's advertiser in the
 * Google Ads Transparency Center — a full Transparency Center URL or a bare
 * AR… advertiser id — into the canonical AR id the Apify provider scrapes via
 * https://adstransparency.google.com/advertiser/<AR id>.
 *
 * Unlike Meta page tracking there is no keyword/handle fallback: the chosen
 * actor requires the AR advertiser id. The advertiser's display name is
 * backfilled from the scraped ads after the first sync.
 */

export interface ParsedGoogleAdvertiserInput {
  /** Canonical AR… advertiser id (e.g. "AR08888592736429539329"). */
  advertiserId: string;
}

// Google Transparency Center advertiser ids are "AR" followed by a long run of
// digits. Keep the lower bound loose so it survives id-length changes.
const ADVERTISER_ID_RE = /^AR\d{6,}$/;

/** Returns null when the input can't be understood as a Google advertiser. */
export function parseGoogleAdvertiserInput(
  raw: string
): ParsedGoogleAdvertiserInput | null {
  const value = raw.trim();
  if (!value) return null;

  // Bare AR id.
  if (ADVERTISER_ID_RE.test(value)) return { advertiserId: value };

  // A Transparency Center URL (with or without scheme). The AR id is the path
  // segment after "advertiser"; the URL may also carry a "/creative/CR…" tail.
  if (/adstransparency\.google\.com/i.test(value)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      return null;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const idx = segments.findIndex((s) => s.toLowerCase() === 'advertiser');
    const candidate = idx >= 0 ? segments[idx + 1] : undefined;
    if (candidate && ADVERTISER_ID_RE.test(candidate)) {
      return { advertiserId: candidate };
    }
    return null;
  }

  return null;
}

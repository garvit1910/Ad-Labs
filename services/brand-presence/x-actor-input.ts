import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';

/**
 * Input for the Apify actor apidojo/twitter-scraper-lite (nfp1fpt5gUlBwPcor,
 * "Twitter (X.com) Scraper Unlimited").
 *
 * Generated from the actor's live OpenAPI definition
 * (GET /v2/acts/apidojo~twitter-scraper-lite/builds/default/openapi.json,
 * fetched 2026-07-08) — NOT from the console UI field names. Notable:
 * `searchTerms` accepts Twitter's full advanced-search syntax verbatim
 * (quotes, @, -from:, -filter:retweets, since:/until:), and an UNSET
 * `maxItems` means UNLIMITED results (opposite of the Google Maps actor) —
 * every run must set it explicitly. `twitterHandles`/`startUrls` scrape a
 * profile's own timeline (marketing, not voice-of-customer) and are never
 * used here.
 */
export interface XScraperInput {
  searchTerms?: string[];
  /** 'Latest' keeps results chronological — required for since: cursor
   * coherence ('Latest + Top' duplicates items across the two passes). */
  sort?: 'Top' | 'Latest' | 'Latest + Top';
  /** ⚠️ Unset = unlimited. Always set explicitly. */
  maxItems?: number;
  start?: string;
  end?: string;
  /** Timeline scrape — never used (brand's own tweets, not VOC). */
  twitterHandles?: string[];
  /** Timeline/URL scrape — never used. */
  startUrls?: string[];
  /** Echoes the matching search term on each dataset item — how a batched
   * multi-query run attributes each tweet back to the query that found it. */
  includeSearchTerms?: boolean;
}

/** The two query tiers. Handle-mention results are self-disambiguating
 * (someone tagged the account) and skip the relevance gate; name-variant
 * keyword results are the most ambiguous source in the system and every one
 * is gated before extraction. */
export interface XQuerySet {
  handleQuery: string | null;
  variantQueries: string[];
}

const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/** Path segments on x.com that are never profile handles. */
const RESERVED_X_PATHS = new Set([
  'home',
  'search',
  'explore',
  'notifications',
  'messages',
  'settings',
  'hashtag',
  'intent',
  'i',
  'share',
  'compose',
]);

/**
 * '@Acme', 'acme', 'https://x.com/Acme?s=20', 'twitter.com/Acme/status/1…'
 * -> 'Acme'. Returns null for anything that is not a valid X handle.
 */
export function normalizeXHandle(raw: string): string | null {
  let candidate = raw.trim();
  if (candidate === '') return null;
  const urlMatch = candidate.match(
    /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)/i,
  );
  if (urlMatch) candidate = urlMatch[1];
  candidate = candidate.replace(/^@/, '');
  if (!HANDLE_PATTERN.test(candidate)) return null;
  if (RESERVED_X_PATHS.has(candidate.toLowerCase())) return null;
  return candidate;
}

/** ISO timestamp -> the 'since:YYYY-MM-DD' operator's date (UTC). Twitter's
 * since: is day-granular, so refresh runs re-fetch the cursor day and the
 * idempotent mention upsert absorbs the overlap. */
export function formatSinceDate(iso: string): string | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Builds the per-brand saved-search set. Mandatory operators on every query:
 * `-filter:retweets` (retweets are duplicate text — never pay for them) and
 * `-from:{handle}` when the handle is known (the brand's own tweets are
 * marketing, not voice-of-customer; the normalizer also drops them
 * defensively). Refresh runs append `since:` from the cursor — the date
 * operator lives in the query string, not an actor input field.
 */
export function buildXQuerySet(params: {
  handle: string | null;
  nameVariants: string[];
  /** ISO timestamp of the newest stored tweet (meta.cursor.lastPostedAt). */
  sinceDate?: string | null;
}): XQuerySet {
  const handle = params.handle ? normalizeXHandle(params.handle) : null;
  const since = params.sinceDate ? formatSinceDate(params.sinceDate) : null;
  const suffix = `${handle ? ` -from:${handle}` : ''} -filter:retweets${since ? ` since:${since}` : ''}`;

  const handleQuery = handle ? `@${handle}${suffix}` : null;

  const seen = new Set<string>();
  const variantQueries: string[] = [];
  for (const variant of params.nameVariants) {
    // Quotes would break the exact-phrase operator; strip them from the term.
    const term = variant.trim().replace(/"/g, '');
    if (term === '') continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    // An '@handle' (or bare handle) variant duplicates the handle query.
    if (handle && key.replace(/^@/, '') === handle.toLowerCase()) continue;
    seen.add(key);
    variantQueries.push(`"${term}"${suffix}`);
    if (
      variantQueries.length >= BRAND_PRESENCE_CONFIG.x.variantSearch.maxVariants
    ) {
      break;
    }
  }

  return { handleQuery, variantQueries };
}

/** Every run: chronological sort (cursor coherence), the per-item search-term
 * echo (tier/query attribution), and an EXPLICIT maxItems — an unset cap
 * means unlimited on this actor. */
export function buildXSearchInput(
  queries: string[],
  opts: { maxItems: number },
): XScraperInput {
  return {
    searchTerms: queries,
    sort: 'Latest',
    maxItems: opts.maxItems,
    includeSearchTerms: true,
  };
}

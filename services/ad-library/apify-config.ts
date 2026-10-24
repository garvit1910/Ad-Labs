/**
 * Server-only Apify configuration for the Ad Library scraper. APIFY_TOKEN must
 * never reach the browser (no NEXT_PUBLIC_ prefix) — it is read here via
 * process.env and consumed only by the server-side provider/probe.
 */
import { ApifyClient } from 'apify-client';

/** curious_coder/facebook-ads-library-scraper. */
export const APIFY_AD_LIBRARY_ACTOR_ID = 'XtaWFhbtfxyzqrFmd';

/**
 * silva95gustavo/google-ads-scraper — scrapes the Google Ads Transparency
 * Center. Rental actor; the rental/free-trial must be activated on the Apify
 * account that owns APIFY_TOKEN before API runs are authorized.
 */
export const APIFY_GOOGLE_ADS_ACTOR_ID = 'N8vqwV9wL9wpIsLDz';

/**
 * Default per-sync ceiling, not a target: the actor stops at the page's real ad
 * count (a 12-ad page returns 12) and bills per result returned, so this only
 * caps very large advertisers. Kept at 250 so a run finishes well inside the
 * sync processor's MAX_RUN_WALL_MS ceiling (a run past that ceiling is aborted
 * and the job fails retryable; the Google actor crawls at concurrency 1 and
 * takes ~30 min for 250 ads). Override with APIFY_AD_LIBRARY_MAX_ADS.
 */
const DEFAULT_MAX_ADS = 250;
/** The actor rejects runs with fewer than 10 "Maximum charged results". */
export const APIFY_MIN_ADS = 10;

export function getApifyToken(): string {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) {
    throw new Error('APIFY_TOKEN is not configured');
  }
  return token;
}

/**
 * Per control-plane HTTP call ceiling (`start`/`get`/`listItems`). The SDK's
 * client-level `timeoutSecs` defaults to 360s and is retried up to 8×, so a
 * wedged call could pin a processor slot for ~48 min; we tighten it to a
 * small bound. Override with APIFY_CONTROL_TIMEOUT_MS.
 */
const DEFAULT_CONTROL_TIMEOUT_MS = 120_000;

export function getApifyControlTimeoutMs(): number {
  const raw = process.env.APIFY_CONTROL_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CONTROL_TIMEOUT_MS;
}

/**
 * The blocking `.call()` path (dev/synchronous `fetchAds`) polls until the run
 * finishes, so its bound must cover a whole run — 15 min covers typical runs
 * on this path; the async run lifecycle (with its 60-min MAX_RUN_WALL_MS
 * ceiling) owns slower production runs. Override with APIFY_CALL_TIMEOUT_MS.
 */
const DEFAULT_CALL_TIMEOUT_MS = 900_000;

export function getApifyCallTimeoutMs(): number {
  const raw = process.env.APIFY_CALL_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CALL_TIMEOUT_MS;
}

/**
 * The configured Apify client. Bounds every control-plane HTTP request at the
 * socket level: `timeoutSecs` replaces the 360s default with the tighter
 * control ceiling (also applies to `.call()`'s ~60s poll requests), and
 * `maxRetries` is capped so a persistently stalling endpoint can't compound to
 * ~48 min of retries. Provider-level `withApifyTimeout` bounds control flow on
 * top of this. Providers still accept an injected client for tests.
 */
export function createApifyClient(): ApifyClient {
  return new ApifyClient({
    token: getApifyToken(),
    timeoutSecs: Math.max(1, Math.ceil(getApifyControlTimeoutMs() / 1000)),
    maxRetries: 3,
  });
}

/** Max ads to scrape per run; overridable via APIFY_AD_LIBRARY_MAX_ADS. */
export function getApifyMaxAds(): number {
  const raw = process.env.APIFY_AD_LIBRARY_MAX_ADS?.trim();
  if (!raw) return DEFAULT_MAX_ADS;
  const parsed = Number(raw);
  const value =
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_ADS;
  return Math.max(value, APIFY_MIN_ADS);
}

/**
 * The actor input for a keyword search URL.
 *
 * `activeStatus` is the cost lever: the actor bills per result RETURNED, so
 * pulling `'all'` (active + inactive) re-bills an advertiser's dead ads on every
 * daily re-scrape. The first sync of a competitor uses `'all'` (backfill its full
 * history, including already-stopped proven winners); every later sync uses
 * `'active'` so we stop paying to re-pull ads we already have and that are no
 * longer delivering. Defaults to `'all'` to preserve behavior for any caller that
 * doesn't opt in. See `scrape-cache.ts` — this value is part of the cache key.
 */
export function buildApifyActorInput(
  searchUrl: string,
  count: number,
  activeStatus: 'all' | 'active' = 'all'
) {
  return {
    urls: [{ url: searchUrl }],
    count,
    scrapeAdDetails: true,
    'scrapePageAds.activeStatus': activeStatus,
    'scrapePageAds.countryCode': 'ALL',
    'scrapePageAds.sortBy': 'impressions_desc',
    'scrapePageAds.period': '',
  };
}

/** Transparency Center advertiser URL for a given AR advertiser id. */
export function buildGoogleAdvertiserUrl(advertiserId: string): string {
  // region=anywhere returns the advertiser's ads across all regions.
  return `https://adstransparency.google.com/advertiser/${advertiserId}?region=anywhere`;
}

/**
 * The google-ads-scraper input. `ocr` recovers copy baked into image/text ads
 * (folded into the existing text fields). `skipDetails:false` keeps the
 * per-ad detail (variations text, dates, regions) the normalizer needs.
 */
export function buildGoogleActorInput(advertiserUrl: string, count: number) {
  return {
    startUrls: [{ url: advertiserUrl }],
    resultsLimit: count,
    skipDetails: false,
    ocr: true,
  };
}

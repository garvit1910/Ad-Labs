/**
 * Ad Library provider abstraction.
 *
 * Implementations fetch competitor ads from an ad transparency surface
 * (Meta Ad Library today; TikTok/Google later) and normalize them to the
 * `library_ads` row shape. Provider selection happens in `index.ts` via the
 * AD_LIBRARY_PROVIDER env var so the sync job is identical for mock and
 * real data.
 */

export type AdLibraryMediaType =
  | 'image'
  | 'video'
  | 'carousel'
  | 'text'
  | 'unknown';

export interface AdSpendRange {
  lowerBound: number;
  upperBound: number | null;
}

/** One ad, normalized. Mirrors the `library_ads` columns the sync job writes. */
export interface NormalizedAd {
  externalAdId: string;
  /**
   * Advertiser identity resolved from the scraped ad — the Meta Page ID for
   * Meta, or the Google AR advertiser id for Google. Used to backfill the
   * competitor's resolved id/name after the first sync.
   */
  pageId?: string | null;
  adSnapshotUrl: string | null;
  creativeBodies: string[];
  creativeLinkTitles: string[];
  pageName: string | null;
  publisherPlatforms: string[];
  /** ISO timestamp. */
  deliveryStart: string;
  /** ISO timestamp, null while the ad is still delivering. */
  deliveryStop: string | null;
  euTotalReach: number | null;
  currency: string | null;
  spendRange: AdSpendRange | null;
  mediaType: AdLibraryMediaType;
  /** Still images for display/thumbnails (poster frame for video ads). */
  mediaUrls: string[] | null;
  /** Playable video URLs (mp4) for video/carousel ads; omitted otherwise. */
  videoUrls?: string[] | null;
  /**
   * Google only: the Transparency Center actor's own served-day count. The
   * longevity basis for Google win scoring (more reliable than the
   * firstSeen→lastSeen span). Omitted/null for Meta.
   */
  numServedDays?: number | null;
  /**
   * The ad's destination URL (Meta `snapshot.link_url`, Google
   * `variations[].clickUrl`). Cross-platform brand-pairing key.
   */
  landingUrl?: string | null;
  /**
   * Normalized landing domain derived from landingUrl (or Meta's display
   * caption). See services/ad-library/landing-domain.ts.
   */
  landingDomain?: string | null;
}

export interface FetchAdsOptions {
  /** ISO country codes for ad_reached_countries. Defaults to EU coverage. */
  countries?: string[];
  /** Page size; providers clamp to their own maximum. */
  limit?: number;
  /** Opaque pagination cursor from a previous page's nextCursor. */
  after?: string;
  /**
   * Meta cost lever: `'all'` pulls active + inactive ads (first-sync backfill),
   * `'active'` only currently-delivering ads (incremental re-syncs, so the
   * per-result-billed actor stops re-charging for dead ads). Defaults to `'all'`.
   * Ignored by providers that don't support it (mock, Google).
   */
  activeStatus?: 'all' | 'active';
  signal?: AbortSignal;
}

export interface FetchAdsResult {
  ads: NormalizedAd[];
  /** Present when another page exists. */
  nextCursor?: string;
  /** The unmodified provider response page, persisted to R2 by the sync job. */
  rawPayload: unknown;
}

/**
 * What to fetch. Keyword search is the primary model (Apify); pageId is the
 * legacy page-based path (Meta Graph). Providers use whichever they support
 * and apply their own country default.
 */
export interface AdLibraryQuery {
  /** Keyword search term (Apify search-URL path). */
  keyword?: string;
  /**
   * Facebook page vanity handle → scraped via the raw page URL. Fallback only:
   * a private/region-gated page defeats this path, so a known numeric pageId
   * always wins (see sync/page-id-resolution.ts for the automatic backfill).
   */
  pageHandle?: string;
  /** Numeric Meta Page ID → scraped via the Ad Library view_all_page_id URL (privacy-immune, preferred). */
  pageId?: string;
  /** Google AR advertiser id → scraped via the Transparency Center advertiser URL. */
  advertiserId?: string;
  /** ISO country code; providers apply their own default (Apify: US). */
  country?: string;
}

export type AdLibraryRunState = 'running' | 'succeeded' | 'failed';

export interface AdLibraryRunStatus {
  state: AdLibraryRunState;
  /** Present when state === 'succeeded'. */
  result?: FetchAdsResult;
  /** Hint for 'failed' — whether the sync job should retry. */
  retryable?: boolean;
}

export interface AdLibraryProvider {
  readonly name: 'meta' | 'mock' | 'apify' | 'google';
  /**
   * Synchronous fetch. Instant for mock/meta; blocking (~1-3 min) for Apify —
   * used by dev scripts. The serverless sync job prefers the start/poll
   * lifecycle below when a provider implements it.
   */
  fetchAds(
    _query: AdLibraryQuery,
    _opts?: FetchAdsOptions
  ): Promise<FetchAdsResult>;
  /**
   * Optional cron-resumable lifecycle for long-running providers. startRun
   * kicks off work and returns an opaque provider run id; pollRun reports
   * status and returns the result once finished. Providers that resolve
   * instantly omit these.
   */
  startRun?(
    _query: AdLibraryQuery,
    _opts?: FetchAdsOptions
  ): Promise<string>;
  pollRun?(_providerRunId: string): Promise<AdLibraryRunStatus>;
  /**
   * Stops a run that the sync job is abandoning so it stops billing. Callers
   * treat failures as best-effort; implementations should still throw so the
   * caller can log them.
   */
  abortRun?(_providerRunId: string): Promise<void>;
}

export class AdLibraryProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = 'AdLibraryProviderError';
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

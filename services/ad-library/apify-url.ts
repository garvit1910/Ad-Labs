import { DEFAULT_AD_LIBRARY_COUNTRY } from '@/lib/brand-identity/countries';

/**
 * Builds a Meta Ad Library keyword-search URL. The Apify
 * `curious_coder/facebook-ads-library-scraper` actor takes URLs, not
 * keywords, so a keyword + country is reconstructed into the search URL the
 * actor scrapes.
 */
export function buildAdLibrarySearchUrl(
  keyword: string,
  country: string = DEFAULT_AD_LIBRARY_COUNTRY
): string {
  const params = new URLSearchParams({
    active_status: 'all',
    ad_type: 'all',
    country: country.toUpperCase(),
    q: keyword,
    search_type: 'keyword_unordered',
    media_type: 'all',
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

/**
 * Builds a raw Facebook page URL from a vanity handle. The actor's page-ads
 * mode scrapes this directly (no numeric Page ID needed) — e.g.
 * `uprootclean` → all of Uproot Clean's ads.
 */
export function buildFacebookPageUrl(handle: string): string {
  return `https://www.facebook.com/${handle}`;
}

/**
 * Builds a Meta Ad Library URL for a specific advertiser Page (all of that
 * page's ads via `view_all_page_id`). Used when tracking a competitor by Meta
 * Page ID instead of a keyword.
 */
export function buildAdLibraryPageUrl(
  pageId: string,
  country: string = DEFAULT_AD_LIBRARY_COUNTRY
): string {
  const params = new URLSearchParams({
    active_status: 'all',
    ad_type: 'all',
    country: country.toUpperCase(),
    view_all_page_id: pageId,
    search_type: 'page',
    media_type: 'all',
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

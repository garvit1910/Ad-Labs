/**
 * Typed input for memo23/trustpilot-scraper-ppe, generated from the actor's
 * LIVE OpenAPI definition (fetched 2026-07-09;
 * scratchpad/trustpilot-actor-openapi.json).
 *
 * Key actor facts (validated against the live schema + a real probe run):
 * - `startUrls` accepts full review URLs OR bare domain slugs (`nike.com`); a
 *   wrong slug triggers the actor's INTERNAL search fallback, so the resolve
 *   probe must verify the returned company domain (non-empty != confirmed).
 * - `searchTerms` runs the autosuggest brand-name search (fallback candidate
 *   discovery) — kept in a SEPARATE run from startUrls (the two modes are
 *   never mixed).
 * - `filterStars` is an enum of `"1"`–`"5"` strings — Run A = `["1","2"]`;
 *   Run B omits it (unfiltered).
 * - `startDate` (`YYYY-MM-DD`) is a hard cutoff with auto newest-first
 *   pagination short-circuit → the refresh-cursor knob (day granularity).
 * - `maxItems` is a PER-INPUT cap (actor default 10000) — set EXPLICITLY on
 *   every run including probes (pay-per-event billing).
 * - `includeCompanyDetails`/`includeStats`/`includeTransparency` attach the
 *   company block + star distribution per row; ON for probe + refresh (cheap),
 *   OFF for backfills (bloat).
 * - `expandRegionalDomains` DEFAULTS TRUE — `false` on probe/scrape
 *   (single-BU provenance), `true` only on the fallback search (regional
 *   pages become candidates).
 */
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';

export interface TrustpilotScraperInput {
  /** Full review URLs or bare domain slugs — never combined with searchTerms. */
  startUrls?: string[];
  /** Autosuggest brand-name search — the fallback-candidate mode. */
  searchTerms?: string[];
  /** Star filter enum `"1"`–`"5"`; present only on the 1–2★ backfill. */
  filterStars?: string[];
  /** Absolute `YYYY-MM-DD` floor — only reviews newer than this (refresh). */
  startDate?: string;
  /** Newest-first sort, set explicitly on backfills/refresh. */
  sortBy?: 'recent';
  /** Integer per-input cap — the actor default is huge, so set it every run. */
  maxItems: number;
  includeCompanyDetails?: boolean;
  includeStats?: boolean;
  includeTransparency?: boolean;
  /** Defaults TRUE on the actor — off for single-BU scrapes, on for search. */
  expandRegionalDomains?: boolean;
}

export type TrustpilotReviewsPhase =
  | 'backfill_negative'
  | 'backfill_full'
  | 'refresh';

/**
 * Resolution probe: a handful of items carries the company block + stats for
 * the confirm card. Enrichment ON (cheap at 5 items), single-BU provenance
 * (expand OFF), newest-first.
 */
export function buildProbeInput(domain: string): TrustpilotScraperInput {
  return {
    startUrls: [domain],
    maxItems: BRAND_PRESENCE_CONFIG.trustpilot.probeMaxItems,
    includeCompanyDetails: true,
    includeStats: true,
    includeTransparency: true,
    expandRegionalDomains: false,
    sortBy: 'recent',
  };
}

/**
 * Fallback candidate discovery: autosuggest search over the brand name
 * variants (NO startUrls — the modes are never mixed). Company details ON so
 * each candidate carries its domain/score/count; regional pages expanded so
 * a locale-specific business unit can surface as a candidate.
 */
export function buildSearchInput(
  searchTerms: string[],
): TrustpilotScraperInput {
  return {
    searchTerms,
    maxItems: BRAND_PRESENCE_CONFIG.trustpilot.searchMaxItems,
    includeCompanyDetails: true,
    includeStats: true,
    expandRegionalDomains: true,
  };
}

/**
 * One phase's actor input for the confirmed page. The backfill runs
 * newest-first in two passes: `backfill_negative` (1–2★ only, enrichment OFF
 * — bad reviews are the signal the cap must not truncate) then `backfill_full`
 * (unfiltered, deeper cap). Refresh is a single enriched newest-first pass
 * bounded by the day-sliced posted_at cursor.
 */
export function buildReviewsInput(params: {
  url: string;
  phase: TrustpilotReviewsPhase;
  /** ISO posted_at cursor — refresh phase only. */
  refreshCursor?: string | null;
}): TrustpilotScraperInput {
  const { trustpilot } = BRAND_PRESENCE_CONFIG;
  switch (params.phase) {
    case 'backfill_negative':
      return {
        startUrls: [params.url],
        filterStars: ['1', '2'],
        sortBy: 'recent',
        maxItems: trustpilot.negativeBackfillMaxItems,
        expandRegionalDomains: false,
      };
    case 'backfill_full':
      return {
        startUrls: [params.url],
        sortBy: 'recent',
        maxItems: trustpilot.backfillMaxItems,
        expandRegionalDomains: false,
      };
    case 'refresh':
      return {
        startUrls: [params.url],
        sortBy: 'recent',
        maxItems: trustpilot.refreshMaxItems,
        includeCompanyDetails: true,
        includeStats: true,
        expandRegionalDomains: false,
        ...(params.refreshCursor
          ? { startDate: params.refreshCursor.slice(0, 10) }
          : {}),
      };
  }
}

/**
 * Typed input for compass/google-maps-reviews-scraper, generated from the
 * actor's LIVE OpenAPI definition (GET /v2/actors/compass~google-maps-
 * reviews-scraper/builds/default/openapi.json, fetched 2026-07-07).
 *
 * Key actor facts (validated against the live schema + a real run):
 * - `startUrls` accepts /maps/place, /maps/search, /maps/reviews URLs (and
 *   google.com/maps?cid=... / share short links, which it follows).
 * - `maxReviews` min is 1, DEFAULT 10,000,000 — pay-per-result billing means
 *   every run must set it explicitly.
 * - `personalData` DEFAULTS TRUE — always sent false; with it off the actor
 *   nulls reviewer identity fields (reviewerId, name, reviewerUrl) AND
 *   reviewUrl, so mention URLs fall back to the item's place-level url.
 * - `reviewsStartDate` accepts absolute YYYY-MM-DD (day granularity) — the
 *   incremental-refresh hook; combined with reviewsSort 'newest' it makes a
 *   cursor-bounded window (lowest-first sorting breaks date incrementality).
 * - Observed output item (2026-07-07 run): reviewId, text, textTranslated,
 *   stars (the review rating — the `rating` key is a different, usually-null
 *   field), publishedAtDate (ISO), likesCount, reviewUrl,
 *   responseFromOwnerText/Date, reviewImageUrls, reviewerId, name, plus
 *   place metadata repeated per row: title, placeId, address (nullable),
 *   totalScore, reviewsCount, url.
 */
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';

export interface GoogleMapsReviewsActorInput {
  startUrls: Array<{ url: string }>;
  /** Integer >= 1 — the actor scrapes ALL reviews when omitted. */
  maxReviews: number;
  reviewsSort: 'newest' | 'mostRelevant' | 'highestRanking' | 'lowestRanking';
  /** Absolute YYYY-MM-DD floor — only reviews newer than this. */
  reviewsStartDate?: string;
  language: string;
  /** Always false — reviewer identities are never needed (author_ref hashes
   * whatever ref remains). */
  personalData: false;
}

export type GoogleReviewsPhase = 'backfill_low' | 'topup_high' | 'refresh';

/** Phase-1 resolution probe: one review is enough to carry the place
 * metadata (title, placeId, totalScore, reviewsCount) for the confirm card. */
export function buildPlaceResolveInput(
  url: string,
): GoogleMapsReviewsActorInput {
  return {
    startUrls: [{ url }],
    maxReviews: 1,
    reviewsSort: 'newest',
    language: BRAND_PRESENCE_CONFIG.google.language,
    personalData: false,
  };
}

/**
 * One phase's actor input for the confirmed place. The backfill runs
 * lowestRanking-first (bad reviews are the signal we must not truncate
 * away); the top-up is a smaller highestRanking run; refreshes are
 * newest-first bounded by the posted_at cursor.
 */
export function buildReviewsInput(params: {
  url: string;
  phase: GoogleReviewsPhase;
  /** ISO posted_at cursor — refresh phase only. */
  refreshCursor?: string | null;
}): GoogleMapsReviewsActorInput {
  const { google } = BRAND_PRESENCE_CONFIG;
  const base = {
    startUrls: [{ url: params.url }],
    language: google.language,
    personalData: false as const,
  };
  switch (params.phase) {
    case 'backfill_low':
      return {
        ...base,
        maxReviews: google.backfillMaxReviews,
        reviewsSort: 'lowestRanking',
      };
    case 'topup_high':
      return {
        ...base,
        maxReviews: Math.max(
          1,
          Math.ceil(google.backfillMaxReviews * google.topUpRatio),
        ),
        reviewsSort: 'highestRanking',
      };
    case 'refresh':
      return {
        ...base,
        maxReviews: google.refreshMaxReviews,
        reviewsSort: 'newest',
        ...(params.refreshCursor
          ? { reviewsStartDate: params.refreshCursor.slice(0, 10) }
          : {}),
      };
  }
}

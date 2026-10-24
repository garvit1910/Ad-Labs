import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';

/**
 * Inputs for the two TikTok clockworks actors behind the tiktok_comments
 * source (a TWO-HOP adapter: profile enumeration budgets the comment
 * harvest — never send all videos to Hop 2).
 *
 * Generated from the actors' live OpenAPI definitions
 * (GET /v2/actors/clockworks~tiktok-profile-scraper/builds/default/openapi.json
 * and .../clockworks~tiktok-comments-scraper/..., fetched 2026-07-10) — NOT
 * from the console UI field names.
 */

/**
 * Hop 1 — clockworks~tiktok-profile-scraper (~$5/1k items). Username ->
 * profile videos with per-video stats (incl. commentCount, the
 * budget-allocation signal) + author metadata for the confirmation card.
 *
 * Deliberately unused: `oldestPostDateUnified`/`newestPostDate` and the
 * digg-count filters (CHARGED add-on filters), the follower/following and
 * download add-ons, and this actor's OWN commentsPerPost-style fields —
 * comments come from Hop 2 where the per-video cap is controllable.
 */
export interface TikTokProfileScraperInput {
  /** Usernames (no '@'). */
  profiles: string[];
  /** Max posts per profile (actor default 100). Always set explicitly. */
  resultsPerPage: number;
  /** 'latest' keeps enumeration deterministic and recency-complete ('popular'
   * is TikTok-capped at ~400-500 videos and unordered by date). */
  profileSorting: 'latest' | 'popular' | 'oldest';
  /** false — pinned videos are often old but comment-dense; the planner
   * sorts by posted_at itself, never dataset order. */
  excludePinnedPosts: boolean;
}

/**
 * Hop 2 — clockworks~tiktok-comments-scraper (~$1/1k comments). Video URL
 * list -> comments (+ a bounded reply allowance).
 *
 * ⚠️ `commentsPerPost` INCLUDES replies and has an actor minimum of 1 — it
 * can never be 0 and must always be set explicitly. Deliberately unused:
 * `topLevelCommentsPerPost` (the replies-included cap is the budget), and
 * the direct-profile mode (`profiles`/`resultsPerPage`) — it bypasses the
 * Hop-1 treasure-map budgeting and the delta refresh.
 */
export interface TikTokCommentsScraperInput {
  postURLs: string[];
  /** Replies-included per-post cap. Min 1. */
  commentsPerPost: number;
  /** 0 = replies off (actor default). We use a small allowance — threads
   * often carry the real complaint. */
  maxRepliesPerComment: number;
}

/** TikTok usernames: 1-24 chars of [a-z0-9_.], no trailing period. */
const USERNAME_PATTERN = /^[a-z0-9_.]{1,24}$/;

/**
 * 'https://www.tiktok.com/@Acme.Shop?lang=en', 'tiktok.com/@user/video/123',
 * '@user', 'user' -> normalized lowercase username. Returns null for
 * anything that is not a valid TikTok username — including vm.tiktok.com /
 * vt.tiktok.com share links, whose path is an opaque share code, not a
 * username.
 */
export function normalizeTikTokUsername(raw: string): string | null {
  let candidate = raw.trim();
  if (candidate === '') return null;
  if (/^(?:https?:\/\/)?(?:vm|vt)\.tiktok\.com\//i.test(candidate)) {
    return null;
  }
  const urlMatch = candidate.match(
    /^(?:https?:\/\/)?(?:www\.|m\.)?tiktok\.com\/@([^/?#]+)/i,
  );
  if (urlMatch) {
    candidate = urlMatch[1];
  } else if (/tiktok\.com/i.test(candidate)) {
    // A tiktok.com URL without an /@username segment (share links, feed
    // URLs) carries no username.
    return null;
  }
  candidate = candidate.replace(/^@/, '').toLowerCase();
  if (!USERNAME_PATTERN.test(candidate)) return null;
  if (candidate.endsWith('.')) return null;
  if (/^\.+$/.test(candidate)) return null;
  return candidate;
}

export function canonicalTikTokProfileUrl(username: string): string {
  return `https://www.tiktok.com/@${username}`;
}

/** Small Hop-1 probe: a handful of latest videos carries the author card. */
export function buildProfileProbeInput(
  username: string,
): TikTokProfileScraperInput {
  return {
    profiles: [username],
    resultsPerPage: BRAND_PRESENCE_CONFIG.tiktok.probeMaxVideos,
    profileSorting: 'latest',
    excludePinnedPosts: false,
  };
}

/** Full Hop-1 enumeration: the treasure map (fresh commentCounts for every
 * tracked video + newly posted ones). Runs on backfill AND every refresh. */
export function buildProfileEnumerationInput(
  username: string,
): TikTokProfileScraperInput {
  return {
    profiles: [username],
    resultsPerPage: BRAND_PRESENCE_CONFIG.tiktok.enumerationMaxVideos,
    profileSorting: 'latest',
    excludePinnedPosts: false,
  };
}

/** One Hop-2 batch run. The Math.max(1, …) is the "can never be 0" guard —
 * the actor's minimum is 1 and its empty/unset semantics are not trusted. */
export function buildCommentsInput(batch: {
  urls: string[];
  commentsPerPost: number;
}): TikTokCommentsScraperInput {
  return {
    postURLs: batch.urls,
    commentsPerPost: Math.max(1, Math.floor(batch.commentsPerPost)),
    maxRepliesPerComment:
      BRAND_PRESENCE_CONFIG.tiktok.backfill.maxRepliesPerComment,
  };
}

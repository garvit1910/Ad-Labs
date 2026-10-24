import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';

/**
 * Input builders for the instagram_comments source — ONE official actor
 * (apify/instagram-scraper, $2.30/1k results) invoked in different
 * content-type MODES, unlike TikTok's two-actor split: `details` is the
 * confirmation probe, `posts`/`reels` are the Hop-1 enumeration (reels ARE a
 * separate resultsType — a profile's reels do not reliably ride the posts
 * feed, and their comment sections are often the richest), and `comments` is
 * the Hop-2 harvest. Two-hop discipline is unchanged: enumeration budgets
 * the harvest; never send all posts to Hop 2.
 *
 * Generated from the actor's live OpenAPI definition
 * (GET /v2/actors/apify~instagram-scraper/builds/default/openapi.json,
 * fetched 2026-07-10) — NOT from the console UI. Output shapes pinned
 * against live probe runs the same day (see instagram-normalizer.ts).
 *
 * Deliberately unused inputs: `search`/`searchType`/`searchLimit` (we are
 * URL-driven only — URLs take priority over search and must never be
 * combined with it) and `addParentData` (it only labels FEED items with a
 * dataSource tag; it does NOT attach parent-post data to comment items —
 * comment→post provenance is our own run→post mapping).
 */
export interface InstagramScraperInput {
  /** Mode-appropriate URLs: `/{username}/` for details/posts/reels,
   * `/p/{shortcode}/` for comments. */
  directUrls: string[];
  resultsType: 'posts' | 'details' | 'comments' | 'reels';
  /** Per-URL item cap. NO schema default and minimum 1 — every run sets it
   * explicitly; never derive 0. ⚠️ Comments mode is hard-capped by the
   * actor at 50 comments per post. */
  resultsLimit: number;
  /** UTC date floor (`YYYY-MM-DD`) for posts/reels enumeration — the cheap
   * refresh lever. Pinned posts may still appear despite the filter
   * (harmless: the registry upsert is idempotent). */
  onlyPostsNewerThan?: string;
}

/** Comments mode cannot fetch more than 50 comments per post (actor limit —
 * "Instagram may return fewer than 15 comments on some posts"). */
export const INSTAGRAM_COMMENTS_ACTOR_MAX = 50;

/** Instagram usernames: 1-30 chars of [a-z0-9_.], no leading/trailing
 * period, no consecutive periods. */
const USERNAME_PATTERN = /^[a-z0-9_.]{1,30}$/;

/** Non-profile first path segments on instagram.com — a pasted post/reel/
 * explore URL is NOT a profile and must be rejected, not treated as a
 * username. */
const RESERVED_PATHS = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'explore',
  'accounts',
  'direct',
  'about',
  'developer',
  'legal',
  'web',
]);

/**
 * 'https://www.instagram.com/Acme.Shop/?hl=en', 'instagram.com/acme',
 * '@acme', 'acme' -> normalized lowercase username (Instagram usernames are
 * case-insensitive). Returns null for anything that is not a valid profile
 * reference — including post/reel/explore URLs, whose path is content, not
 * a username.
 */
export function normalizeInstagramUsername(raw: string): string | null {
  let candidate = raw.trim();
  if (candidate === '') return null;
  const urlMatch = candidate.match(
    /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#]+)/i,
  );
  if (urlMatch) {
    candidate = urlMatch[1];
    if (RESERVED_PATHS.has(candidate.toLowerCase())) return null;
  } else if (/instagram\.com/i.test(candidate)) {
    // An instagram.com URL with no path segment carries no username.
    return null;
  }
  candidate = candidate.replace(/^@/, '').toLowerCase();
  if (!USERNAME_PATTERN.test(candidate)) return null;
  if (candidate.startsWith('.') || candidate.endsWith('.')) return null;
  if (candidate.includes('..')) return null;
  return candidate;
}

/** Trailing slash matters — the actor's URL grammar is `/{username}/`. */
export function canonicalInstagramProfileUrl(username: string): string {
  return `https://www.instagram.com/${username}/`;
}

/**
 * The canonical `/p/{shortcode}/` form. Works for reels too — Instagram
 * serves both paths for one shortcode, and the actor itself emits `/p/`
 * URLs for reels-mode items (verified against a live run 2026-07-10) — so
 * comments mode gets `/p/` regardless of the post's kind.
 */
export function canonicalInstagramPostUrl(shortcode: string): string {
  return `https://www.instagram.com/p/${shortcode}/`;
}

/** Parses `/p/`, `/reel/`, `/reels/`, `/tv/` content URLs on any
 * instagram.com host. kind mirrors the registry's post/reel split ('tv' is
 * legacy IGTV — video content, filed as 'reel'). */
export function parseInstagramPostUrl(
  raw: string,
): { shortcode: string; kind: 'post' | 'reel' } | null {
  const match = raw
    .trim()
    .match(
      /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i,
    );
  if (!match) return null;
  return {
    shortcode: match[2],
    kind: match[1].toLowerCase() === 'p' ? 'post' : 'reel',
  };
}

/** Tiny details-mode probe: one item is the whole profile card (username,
 * fullName, followersCount, postsCount, private flag). ~$0.003. */
export function buildProfileProbeInput(
  username: string,
): InstagramScraperInput {
  return {
    directUrls: [canonicalInstagramProfileUrl(username)],
    resultsType: 'details',
    resultsLimit: BRAND_PRESENCE_CONFIG.instagram.probeMaxItems,
  };
}

/**
 * Hop-1 enumeration — one run per content mode (posts AND reels; the
 * planner treats them uniformly, `kind` rides the registry row). Refresh
 * passes `newerThan` (day-sliced, minus an overlap allowance) so old
 * already-enumerated posts are not re-billed; the tracked comment-rich
 * posts get their fresh counts from the recheck run instead.
 */
export function buildPostsEnumerationInput(
  username: string,
  opts: { mode: 'posts' | 'reels'; newerThan?: string | null },
): InstagramScraperInput {
  return {
    directUrls: [canonicalInstagramProfileUrl(username)],
    resultsType: opts.mode,
    resultsLimit: BRAND_PRESENCE_CONFIG.instagram.enumerationMaxPosts,
    ...(opts.newerThan ? { onlyPostsNewerThan: opts.newerThan } : {}),
  };
}

/**
 * Refresh recheck: fresh commentsCount for the tracked comment-rich posts.
 * Posts mode over direct post URLs returns ONE full post item per URL at
 * resultsLimit 1 (verified against a live run 2026-07-10 — the limit is
 * per-URL, not global), so this is ~1 result per tracked post (~$0.0023).
 */
export function buildTrackedRecheckInput(
  postUrls: string[],
): InstagramScraperInput {
  return {
    directUrls: postUrls,
    resultsType: 'posts',
    resultsLimit: 1,
  };
}

/**
 * One Hop-2 batch run. resultsLimit is the per-post (per-URL) comment cap —
 * clamped into [1, 50]: the schema minimum is 1 (never derive 0) and the
 * actor never returns more than 50 comments per post.
 */
export function buildCommentsInput(batch: {
  urls: string[];
  commentsPerPost: number;
}): InstagramScraperInput {
  return {
    directUrls: batch.urls,
    resultsType: 'comments',
    resultsLimit: Math.min(
      INSTAGRAM_COMMENTS_ACTOR_MAX,
      Math.max(1, Math.floor(batch.commentsPerPost)),
    ),
  };
}

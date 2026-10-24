import { hashValue } from '@/lib/crypto/oauth-state';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import {
  canonicalInstagramPostUrl,
  parseInstagramPostUrl,
} from './instagram-actor-input';

/**
 * Normalizers for the apify/instagram-scraper modes behind the
 * instagram_comments source (details probe, posts/reels enumeration,
 * comments harvest).
 *
 * Output field names PINNED against live probe runs (2026-07-10):
 * details -> `username`, `fullName`, `followersCount`, `postsCount`,
 * `private`, plus `error`/`errorDescription` marker items ('not_found');
 * posts/reels -> `shortCode`, `url` (always the canonical /p/ form, even in
 * reels mode), `caption`, `timestamp` (ISO), `commentsCount`,
 * `productType` ('clips' = reel); comments -> `id`, `text`, `timestamp`
 * (ISO), `likesCount`, `repliesCount`, `ownerUsername` (+ `owner.username`),
 * `postUrl` (per-item parent attribution — what makes batched harvest runs
 * safe), `commentUrl` (a stable per-comment permalink). Reads stay
 * defensive anyway (x-normalizer discipline: shapes drift across builds);
 * unusable items are skipped, never thrown on.
 */

/** Best-effort string field read from an untyped dataset item. */
function str(item: Record<string, unknown>, key: string): string | null {
  const value = item[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function num(item: Record<string, unknown>, key: string): number | null {
  const value = item[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Counts sometimes arrive as numeric strings.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function obj(
  item: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = item[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An id is only trusted as a string, or as a number when it is a safe
 * integer — Instagram media/comment ids exceed 2^53, so a numeric id has
 * already lost precision at JSON parse and would dedupe-collide across
 * neighbors (the x-normalizer tweet-id rule). */
function readId(item: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return String(value);
    }
  }
  return null;
}

/** `timestamp` is ISO on every mode's items. */
function readPostedAt(item: Record<string, unknown>): string | null {
  const iso = str(item, 'timestamp');
  if (iso) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Body with @mentions and URLs stripped — what's left is the actual words.
 * Instagram-local (NOT the X export): Instagram usernames run to 30 chars
 * and may contain periods, so the X pattern (`@[A-Za-z0-9_]{1,15}`) would
 * leave `@some.tag.chain` counting as real words. Exported for tests.
 */
export function stripInstagramMentionsAndUrls(body: string): string {
  return body
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[A-Za-z0-9_.]{1,30}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The details-mode profile card for the confirmation gate. */
export interface InstagramDetailsCard {
  username: string;
  fullName: string | null;
  followers: number | null;
  postsCount: number | null;
  isPrivate: boolean;
}

export type InstagramProbeOutcome =
  | { kind: 'resolved'; card: InstagramDetailsCard }
  | { kind: 'unavailable'; reason: 'private' | 'not_found'; message: string }
  | { kind: 'degraded' };

/**
 * Classifies a details-mode probe dataset. The actor emits error-marker
 * items instead of failing the run: a missing profile returns
 * `{ error: 'not_found', errorDescription: ... }` (pinned live). A PRIVATE
 * profile still resolves a full details card with `private: true` — that is
 * the explicit terminal state (we cannot read a private profile's posts),
 * surfaced with the card's own data so the panel can show who it found.
 * Anything unclassifiable degrades to the manual-confirm card instead of
 * erroring (a probe transport failure is handled upstream as a retryable
 * run failure, never here).
 */
export function classifyInstagramProbeOutcome(
  items: unknown[],
): InstagramProbeOutcome {
  let errorMessage: string | null = null;
  let errorCode: string | null = null;
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const username = str(item, 'username');
    const error = str(item, 'error');
    if (username && !error) {
      const card: InstagramDetailsCard = {
        username,
        fullName: str(item, 'fullName'),
        followers: num(item, 'followersCount'),
        postsCount: num(item, 'postsCount'),
        isPrivate: item['private'] === true,
      };
      if (card.isPrivate) {
        return {
          kind: 'unavailable',
          reason: 'private',
          message: `@${username} is a private profile — its posts and comments are not publicly readable.`,
        };
      }
      return { kind: 'resolved', card };
    }
    if (error && !errorCode) {
      errorCode = error;
      errorMessage = str(item, 'errorDescription') ?? error;
    }
  }
  if (errorCode) {
    if (/private/i.test(errorCode) || /private/i.test(errorMessage ?? '')) {
      return {
        kind: 'unavailable',
        reason: 'private',
        message: errorMessage ?? errorCode,
      };
    }
    if (
      /not[_\s]*found|does\s*n[o']?t\s*exist|no\s*longer|banned|unavailable/i.test(
        `${errorCode} ${errorMessage ?? ''}`,
      )
    ) {
      return {
        kind: 'unavailable',
        reason: 'not_found',
        message: errorMessage ?? errorCode,
      };
    }
  }
  return { kind: 'degraded' };
}

/** One enumerated post/reel, ready for a brand_presence_instagram_posts
 * upsert. post_id is the SHORTCODE — the URL key every mode round-trips
 * (comment items carry no shortCode field, but their postUrl parses to
 * one). */
export interface NormalizedInstagramPost {
  post_id: string;
  kind: 'post' | 'reel';
  url: string;
  caption: string | null;
  posted_at: string | null;
  comment_count: number;
}

export type NormalizedInstagramPostItem =
  | { kind: 'post'; post: NormalizedInstagramPost }
  | { kind: 'skipped'; reason: string };

/**
 * Normalizes one posts/reels/recheck dataset item into the registry shape.
 * The caption is stored on the registry row because comment items carry no
 * caption — the harvest joins it back in at normalize time (parent_title /
 * extraction context). `runMode` is the fallback kind when the item's own
 * `productType` discriminator ('clips' = reel) is absent.
 */
export function extractInstagramPostFromItem(
  raw: unknown,
  runMode: 'posts' | 'reels',
): NormalizedInstagramPostItem {
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'skipped', reason: 'non-object item' };
  }
  const item = raw as Record<string, unknown>;
  if (str(item, 'error')) {
    // Error-marker items (not-found post/profile) are probe signal, not posts.
    return { kind: 'skipped', reason: 'error-marker item' };
  }

  const shortcode = str(item, 'shortCode') ?? str(item, 'shortcode');
  if (!shortcode) {
    return { kind: 'skipped', reason: 'missing shortCode' };
  }

  const productType = str(item, 'productType');
  const kind: 'post' | 'reel' =
    productType === 'clips' ? 'reel' : runMode === 'reels' ? 'reel' : 'post';

  return {
    kind: 'post',
    post: {
      post_id: shortcode,
      kind,
      url: str(item, 'url') ?? canonicalInstagramPostUrl(shortcode),
      caption: str(item, 'caption'),
      posted_at: readPostedAt(item),
      comment_count: num(item, 'commentsCount') ?? 0,
    },
  };
}

/**
 * Normalized comment ready for a brand_mentions upsert (platform='instagram',
 * data_type='comment', scope='brand', relevance='not_required' — the
 * founder-confirmed own profile is the ownership gate, like TikTok/Maps/
 * Trustpilot/Amazon; the deterministic short-text filter does the heavy
 * lifting on emoji-only / tag-a-friend spam).
 */
export interface NormalizedInstagramComment {
  external_id: string;
  /** The comment's own permalink (`/p/{shortcode}/c/{id}`), falling back to
   * the post URL. */
  url: string | null;
  /** sha256 of the commenter's username — raw identities are never stored. */
  author_ref: string | null;
  body: string;
  posted_at: string | null;
  /** Parent-post linkage (thread anchor + extraction context). */
  post_id: string;
  post_url: string | null;
  post_kind: 'post' | 'reel';
  /** The parent post's caption from the registry lookup — becomes
   * parent_title (extraction context, NEVER a quote source). */
  parent_title: string | null;
  likes: number | null;
  reply_count: number | null;
  /** Body (minus @mentions/URLs) is below config.instagram.minBodyChars —
   * stored with extraction_status='skipped' so "🔥🔥" and tag-a-friend
   * chains never reach the LLM. High kill rates are NORMAL for Instagram. */
  short_text: boolean;
}

export type NormalizedInstagramItem =
  | { kind: 'mention'; mention: NormalizedInstagramComment; rawText: string }
  | { kind: 'skipped'; reason: string };

/**
 * Best-effort parent-post attribution for ANY comments-mode item, kept OR
 * skipped — the harvest's per-post yield accounting must credit a post for
 * every dataset item that proves the scrape covered it (an owner-dropped or
 * short-text item is still coverage evidence; only yielded posts advance
 * their delta baseline). Pinned live: every comment item carries `postUrl`.
 */
export function attributeCommentShortcode(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const fromUrl = str(item, 'postUrl') ?? str(item, 'inputUrl');
  if (fromUrl) {
    const parsed = parseInstagramPostUrl(fromUrl);
    if (parsed) return parsed.shortcode;
  }
  return str(item, 'shortCode') ?? str(item, 'shortcode');
}

/**
 * Normalizes one comments-mode item. Drops enforced here:
 * - owner-authored comments — the brand replying to fans is marketing
 *   voice, not voice-of-customer (the TikTok/X owner-drop mirror, applied
 *   at normalization because the actor has no exclusion input);
 * - items with no resolvable comment id, body, or parent post (a comment
 *   that can't be threaded to a post is unusable — thread anchoring and
 *   caption context both hang off the parent).
 */
export function normalizeInstagramCommentItem(
  raw: unknown,
  ctx: {
    ownerUsername: string;
    /** Registry lookup: shortcode -> its url/caption/kind (the child-table
     * join that supplies parent_title — comment items carry no caption). */
    postLookup: (
      shortcode: string,
    ) =>
      | { url: string; caption: string | null; kind: 'post' | 'reel' }
      | undefined;
  },
): NormalizedInstagramItem {
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'skipped', reason: 'non-object item' };
  }
  const item = raw as Record<string, unknown>;

  const externalId = readId(item, ['id', 'commentId']);
  if (!externalId) {
    // Includes the actor's zero-result / error marker items — expected.
    return { kind: 'skipped', reason: 'missing comment id' };
  }

  const body = str(item, 'text');
  if (!body) {
    return { kind: 'skipped', reason: 'empty body' };
  }

  const owner = obj(item, 'owner');
  const username =
    str(item, 'ownerUsername') ?? (owner ? str(owner, 'username') : null);
  if (
    username &&
    username.toLowerCase() === ctx.ownerUsername.toLowerCase()
  ) {
    return { kind: 'skipped', reason: 'owner-authored comment' };
  }

  const shortcode = attributeCommentShortcode(item);
  if (!shortcode) {
    return { kind: 'skipped', reason: 'unresolvable parent post' };
  }
  const registryPost = ctx.postLookup(shortcode);
  const postUrl =
    str(item, 'postUrl') ??
    registryPost?.url ??
    canonicalInstagramPostUrl(shortcode);

  const stripped = stripInstagramMentionsAndUrls(body);

  return {
    kind: 'mention',
    mention: {
      external_id: externalId,
      url: str(item, 'commentUrl') ?? postUrl,
      author_ref: username ? hashValue(username) : null,
      body,
      posted_at: readPostedAt(item),
      post_id: shortcode,
      post_url: postUrl,
      post_kind: registryPost?.kind ?? 'post',
      parent_title: registryPost?.caption ?? null,
      likes: num(item, 'likesCount'),
      reply_count: num(item, 'repliesCount'),
      short_text:
        stripped.length < BRAND_PRESENCE_CONFIG.instagram.minBodyChars,
    },
    rawText: body,
  };
}

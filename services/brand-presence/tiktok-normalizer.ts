import { hashValue } from '@/lib/crypto/oauth-state';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';

/**
 * Normalizers for the two TikTok clockworks actors (Hop 1 profile/video
 * enumeration, Hop 2 comment harvest).
 *
 * ⚠️ Hop 2's OUTPUT field names are NOT yet pinned against a live run — the
 * actor README/console examples show `cid`, `text`, `diggCount`,
 * `replyCommentTotal`, `createTimeISO`, `uniqueId`, `videoWebUrl`; every
 * read below probes those candidates defensively (x-normalizer discipline:
 * shapes drift across builds; confirm against a real run before trusting
 * new fields). Unusable items are skipped, never thrown on.
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
 * integer — TikTok ids exceed 2^53, so a numeric id has already lost
 * precision at JSON parse and would dedupe-collide across neighbors (the
 * x-normalizer tweet-id rule). */
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

/** createTimeISO (ISO string) ?? createTime (unix seconds) -> ISO. */
function readPostedAt(item: Record<string, unknown>): string | null {
  const iso = str(item, 'createTimeISO');
  if (iso) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  const unix = num(item, 'createTime');
  if (unix !== null && unix > 0) {
    return new Date(unix * 1000).toISOString();
  }
  return null;
}

/**
 * Body with @mentions and URLs stripped — what's left is the actual words.
 * TikTok-local (NOT the X export): TikTok usernames run to 24 chars and may
 * contain periods, so the X pattern (`@[A-Za-z0-9_]{1,15}`) would leave
 * `@some.long.handle` counting as real words. Exported for tests.
 */
export function stripTikTokMentionsAndUrls(body: string): string {
  return body
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[A-Za-z0-9_.]{1,24}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Profile-level metadata carried on every Hop-1 video item (authorMeta). */
export interface TikTokAuthorCard {
  username: string;
  displayName: string | null;
  followers: number | null;
  videoCount: number | null;
}

/**
 * Reads the author card off a Hop-1 item. clockworks nests it under
 * `authorMeta` (`name` = username, `nickName` = display, `fans` = followers,
 * `video` = video count); `author.uniqueId` is the probed fallback shape.
 */
export function extractProfileCardFromItem(
  raw: unknown,
): TikTokAuthorCard | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const authorMeta = obj(item, 'authorMeta');
  if (authorMeta) {
    const username = str(authorMeta, 'name') ?? str(authorMeta, 'uniqueId');
    if (!username) return null;
    return {
      username,
      displayName: str(authorMeta, 'nickName') ?? str(authorMeta, 'nickname'),
      followers: num(authorMeta, 'fans') ?? num(authorMeta, 'followers'),
      videoCount: num(authorMeta, 'video') ?? num(authorMeta, 'videos'),
    };
  }
  const author = obj(item, 'author');
  if (author) {
    const username = str(author, 'uniqueId') ?? str(author, 'unique_id');
    if (!username) return null;
    const stats = obj(item, 'authorStats') ?? obj(author, 'stats');
    return {
      username,
      displayName: str(author, 'nickname') ?? str(author, 'nickName'),
      followers: stats ? num(stats, 'followerCount') : null,
      videoCount: stats ? num(stats, 'videoCount') : null,
    };
  }
  return null;
}

export type TikTokProbeOutcome =
  | { kind: 'resolved'; card: TikTokAuthorCard }
  | { kind: 'unavailable'; reason: 'private' | 'not_found'; message: string }
  | { kind: 'degraded' };

/**
 * Classifies a Hop-1 probe dataset. clockworks actors emit error-marker
 * items (an `error` string) for private / missing profiles instead of
 * failing the run — the exact strings are unpinned, so matching is
 * substring-based and anything unclassifiable degrades to the manual-confirm
 * card instead of erroring (a probe transport failure is handled upstream as
 * a retryable run failure, never here).
 */
export function classifyProbeOutcome(items: unknown[]): TikTokProbeOutcome {
  let errorMessage: string | null = null;
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const card = extractProfileCardFromItem(item);
    if (card) return { kind: 'resolved', card };
    const error =
      str(item, 'error') ?? str(item, 'errorDescription') ?? null;
    if (error && !errorMessage) errorMessage = error;
  }
  if (errorMessage) {
    if (/private/i.test(errorMessage)) {
      return { kind: 'unavailable', reason: 'private', message: errorMessage };
    }
    if (
      /not\s*found|does\s*n[o']?t\s*exist|doesn't\s*exist|no\s*longer|banned|unavailable/i.test(
        errorMessage,
      )
    ) {
      return {
        kind: 'unavailable',
        reason: 'not_found',
        message: errorMessage,
      };
    }
  }
  return { kind: 'degraded' };
}

/** One enumerated video, ready for a brand_presence_tiktok_videos upsert. */
export interface NormalizedTikTokVideo {
  video_id: string;
  url: string;
  caption: string | null;
  posted_at: string | null;
  comment_count: number;
}

export type NormalizedTikTokVideoItem =
  | { kind: 'video'; video: NormalizedTikTokVideo }
  | { kind: 'skipped'; reason: string };

/**
 * Normalizes one Hop-1 dataset item into the video registry shape. The
 * caption (`text`) is stored on the registry row because Hop-2 comment items
 * carry no caption — the harvest joins it back in at normalize time.
 */
export function extractVideoFromItem(raw: unknown): NormalizedTikTokVideoItem {
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'skipped', reason: 'non-object item' };
  }
  const item = raw as Record<string, unknown>;
  if (str(item, 'error')) {
    // Error-marker items (private/not-found) are probe signal, not videos.
    return { kind: 'skipped', reason: 'error-marker item' };
  }

  const videoId = readId(item, ['id', 'videoId', 'awemeId']);
  if (!videoId) {
    return { kind: 'skipped', reason: 'missing video id' };
  }

  let url = str(item, 'webVideoUrl') ?? str(item, 'videoUrl');
  if (!url) {
    const author = extractProfileCardFromItem(item);
    if (!author) {
      return { kind: 'skipped', reason: 'no video URL and no author to synthesize one' };
    }
    url = `https://www.tiktok.com/@${author.username}/video/${videoId}`;
  }

  const stats = obj(item, 'stats');
  const commentCount =
    num(item, 'commentCount') ??
    (stats ? num(stats, 'commentCount') : null) ??
    0;

  return {
    kind: 'video',
    video: {
      video_id: videoId,
      url,
      caption: str(item, 'text') ?? str(item, 'desc'),
      posted_at: readPostedAt(item),
      comment_count: commentCount,
    },
  };
}

/**
 * Normalized comment ready for a brand_mentions upsert (platform='tiktok',
 * data_type='comment', scope='brand', relevance='not_required' — the
 * founder-confirmed own profile is the ownership gate, like Maps/Trustpilot/
 * Amazon; the deterministic short-text filter does the heavy lifting).
 */
export interface NormalizedTikTokComment {
  external_id: string;
  /** The VIDEO url — comments have no stable own permalink. */
  url: string | null;
  /** sha256 of the commenter's username — raw identities are never stored. */
  author_ref: string | null;
  body: string;
  posted_at: string | null;
  /** Parent-video linkage (thread anchor + extraction context). */
  video_id: string;
  video_url: string | null;
  /** The parent video's caption from the registry lookup — becomes
   * parent_title (extraction context, NEVER a quote source). */
  parent_title: string | null;
  likes: number | null;
  reply_count: number | null;
  is_reply: boolean;
  parent_comment_id: string | null;
  /** Body (minus @mentions/URLs) is below config.tiktok.minBodyChars —
   * stored with extraction_status='skipped' so "🔥🔥🔥" and "first" never
   * reach the LLM. A 40-60% kill rate is NORMAL for TikTok. */
  short_text: boolean;
}

export type NormalizedTikTokItem =
  | { kind: 'mention'; mention: NormalizedTikTokComment; rawText: string }
  | { kind: 'skipped'; reason: string };

/** Parses the numeric video/photo id out of a TikTok post URL. */
export function parseVideoIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/\/(?:video|photo)\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Best-effort parent-video attribution for ANY Hop-2 item, kept OR skipped —
 * the harvest's per-video yield accounting must credit a video for every
 * dataset item that proves the scrape covered it (an owner-dropped or
 * short-text item is still coverage evidence; only yielded videos advance
 * their delta baseline).
 */
export function attributeCommentVideoId(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  return (
    parseVideoIdFromUrl(str(item, 'videoWebUrl') ?? str(item, 'postUrl')) ??
    readId(item, ['videoId', 'awemeId', 'postId'])
  );
}

/**
 * Normalizes one Hop-2 comment item. Drops enforced here:
 * - owner-authored comments (incl. replies) — the brand replying to fans is
 *   marketing voice, not voice-of-customer (the X `-from:` mirror, applied
 *   at normalization because the actor has no exclusion input);
 * - items with no resolvable comment id, body, or parent video (a comment
 *   that can't be threaded to a video is unusable — the mention url IS the
 *   video).
 * Replies are KEPT (threads often carry the real complaint), tagged with
 * isReply/parentCommentId; data_type stays 'comment' — the video anchors
 * the thread.
 */
export function normalizeTikTokCommentItem(
  raw: unknown,
  ctx: {
    ownerUsername: string;
    /** Registry lookup: video id -> its url + caption (the child-table join
     * that supplies parent_title — Hop-2 items carry no caption). */
    videoLookup(videoId: string):
      | { url: string; caption: string | null }
      | undefined;
  },
): NormalizedTikTokItem {
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'skipped', reason: 'non-object item' };
  }
  const item = raw as Record<string, unknown>;

  const externalId = readId(item, ['cid', 'id', 'commentId']);
  if (!externalId) {
    // Includes the actor's zero-result / error marker items — expected.
    return { kind: 'skipped', reason: 'missing comment id' };
  }

  const body = str(item, 'text') ?? str(item, 'comment');
  if (!body) {
    return { kind: 'skipped', reason: 'empty body' };
  }

  const user = obj(item, 'user');
  const username =
    str(item, 'uniqueId') ??
    (user ? (str(user, 'uniqueId') ?? str(user, 'unique_id')) : null);
  if (
    username &&
    username.toLowerCase() === ctx.ownerUsername.toLowerCase()
  ) {
    return { kind: 'skipped', reason: 'owner-authored comment' };
  }

  const itemVideoUrl = str(item, 'videoWebUrl') ?? str(item, 'postUrl');
  const videoId = attributeCommentVideoId(item);
  if (!videoId) {
    return { kind: 'skipped', reason: 'unresolvable parent video' };
  }
  const registryVideo = ctx.videoLookup(videoId);
  const videoUrl = itemVideoUrl ?? registryVideo?.url ?? null;

  const parentCommentId = readId(item, ['repliesToId', 'parentCommentId']);
  const stripped = stripTikTokMentionsAndUrls(body);

  return {
    kind: 'mention',
    mention: {
      external_id: externalId,
      url: videoUrl,
      author_ref: username ? hashValue(username) : null,
      body,
      posted_at: readPostedAt(item),
      video_id: videoId,
      video_url: videoUrl,
      parent_title: registryVideo?.caption ?? null,
      likes: num(item, 'diggCount') ?? num(item, 'likesCount'),
      reply_count:
        num(item, 'replyCommentTotal') ??
        num(item, 'replyCommentCount') ??
        num(item, 'repliesCount'),
      is_reply: parentCommentId !== null,
      parent_comment_id: parentCommentId,
      short_text: stripped.length < BRAND_PRESENCE_CONFIG.tiktok.minBodyChars,
    },
    rawText: body,
  };
}

import { hashValue } from '@/lib/crypto/oauth-state';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import { decodeHtmlEntities } from '@/lib/brand-presence/html-entities';
import type { MentionDataType } from '@/lib/brand-presence/types';

/**
 * Normalized tweet ready for a brand_mentions upsert (platform='x',
 * scope='brand'; the tier decides relevance: 'handle' items skip the gate as
 * not_required, 'variant' items are always gated as pending).
 */
export interface NormalizedXMention {
  external_id: string;
  /** 'comment' for replies (often the complaint thread — always kept),
   * 'post' for top-level tweets. */
  data_type: MentionDataType;
  url: string | null;
  /** sha256 of the author's userName — raw identities are never stored. */
  author_ref: string | null;
  body: string;
  posted_at: string;
  /** For replies: the tweet id being replied to, when the actor exposes it. */
  parent_external_id: string | null;
  /** Which saved-search tier produced this tweet (set from the run phase). */
  tier: 'handle' | 'variant';
  /** Actor-echoed search term (includeSearchTerms) — per-query kill-rate
   * attribution for the variant tier. */
  matched_term: string | null;
  /** Display metadata for tags.x — clustering stays count-based. */
  engagement: {
    likes: number | null;
    retweets: number | null;
    replies: number | null;
    quotes: number | null;
    views: number | null;
    authorFollowers: number | null;
    lang: string | null;
  };
  /** Body (minus @mentions/URLs) is below config.x.minBodyChars — stored
   * with extraction_status='skipped' so "@brand 🔥" never reaches the LLM. */
  short_text: boolean;
}

export type NormalizedXItem =
  | { kind: 'mention'; mention: NormalizedXMention; rawText: string }
  | { kind: 'skipped'; reason: string };

/** Best-effort string field read from an untyped dataset item. */
function str(item: Record<string, unknown>, key: string): string | null {
  const value = item[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function num(item: Record<string, unknown>, key: string): number | null {
  const value = item[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // View counts sometimes arrive as numeric strings.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function bool(item: Record<string, unknown>, key: string): boolean {
  return item[key] === true;
}

/** Tweet id: a string, or legacy string keys. A NUMERIC id is only trusted
 * when it is a safe integer — real tweet ids exceed 2^53, so a numeric id
 * has already lost precision at JSON parse and would dedupe-collide across
 * neighboring tweets. */
function readTweetId(item: Record<string, unknown>): string | null {
  const id = item.id;
  if (typeof id === 'string' && id.trim() !== '') return id.trim();
  if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
  return str(item, 'id_str') ?? str(item, 'tweetId');
}

/** Twitter's classic "Thu Jun 09 23:14:19 +0000 2022" parses via Date.parse;
 * ISO strings from newer builds do too. */
function toIso(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** The actor echoes the matching query as a string (or a one-element array
 * on some builds) when includeSearchTerms is on. */
function readMatchedTerm(item: Record<string, unknown>): string | null {
  const direct = str(item, 'searchTerm');
  if (direct) return direct;
  const list = item.searchTerms;
  if (Array.isArray(list) && typeof list[0] === 'string') {
    const first = list[0].trim();
    return first === '' ? null : first;
  }
  return null;
}

/** Body with @mentions and URLs stripped — what's left is the actual words.
 * Exported for the processor's short-text counting/tests. */
export function stripMentionsAndUrls(body: string): string {
  return body
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[A-Za-z0-9_]{1,15}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes one twitter-scraper-lite dataset item. Field reads are
 * defensive (apidojo shapes drift across builds; confirm against a real run
 * before trusting new fields) and unusable items are skipped, never thrown
 * on. Drops enforced here even though the queries already exclude them:
 * retweets (duplicate text) and the brand's own tweets (marketing, not VOC).
 */
export function normalizeXItem(
  raw: unknown,
  ctx: { brandHandle: string | null; tier: 'handle' | 'variant' },
): NormalizedXItem {
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'skipped', reason: 'non-object item' };
  }
  const item = raw as Record<string, unknown>;

  const externalId = readTweetId(item);
  if (!externalId) {
    // Includes the actor's zero-result marker items — expected, not breakage.
    return { kind: 'skipped', reason: 'missing tweet id' };
  }
  if (bool(item, 'isRetweet')) {
    return { kind: 'skipped', reason: 'retweet' };
  }

  const author =
    item.author && typeof item.author === 'object'
      ? (item.author as Record<string, unknown>)
      : {};
  const userName = str(author, 'userName') ?? str(author, 'username');
  if (
    ctx.brandHandle &&
    userName &&
    userName.toLowerCase() === ctx.brandHandle.toLowerCase()
  ) {
    return { kind: 'skipped', reason: 'brand-authored tweet' };
  }

  // X escapes `&`, `<` and `>` in tweet text; store it decoded.
  const body = decodeHtmlEntities(str(item, 'fullText') ?? str(item, 'text'));
  if (!body) {
    return { kind: 'skipped', reason: 'empty body' };
  }
  const postedAt = toIso(str(item, 'createdAt'));
  if (!postedAt) {
    return { kind: 'skipped', reason: 'unparseable createdAt' };
  }

  const isReply = bool(item, 'isReply');
  const stripped = stripMentionsAndUrls(body);

  return {
    kind: 'mention',
    mention: {
      external_id: externalId,
      data_type: isReply ? 'comment' : 'post',
      url: str(item, 'url') ?? str(item, 'twitterUrl'),
      author_ref: userName ? hashValue(userName) : null,
      body,
      posted_at: postedAt,
      parent_external_id: isReply
        ? (str(item, 'inReplyToId') ?? str(item, 'conversationId'))
        : null,
      tier: ctx.tier,
      matched_term: readMatchedTerm(item),
      engagement: {
        likes: num(item, 'likeCount'),
        retweets: num(item, 'retweetCount'),
        replies: num(item, 'replyCount'),
        quotes: num(item, 'quoteCount'),
        views: num(item, 'viewCount'),
        authorFollowers: num(author, 'followers') ?? num(author, 'followersCount'),
        lang: str(item, 'lang'),
      },
      short_text: stripped.length < BRAND_PRESENCE_CONFIG.x.minBodyChars,
    },
    rawText: body,
  };
}

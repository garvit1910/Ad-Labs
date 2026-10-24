import { hashValue } from '@/lib/crypto/oauth-state';
import { decodeHtmlEntities } from '@/lib/brand-presence/html-entities';
import type {
  MentionDataType,
  VerifiedCommunity,
} from '@/lib/brand-presence/types';

/**
 * Normalized post/comment ready for a brand_mentions upsert (scope/relevance
 * are assigned by the scrape processor per run mode).
 */
export interface NormalizedRedditMention {
  external_id: string;
  data_type: MentionDataType;
  url: string | null;
  subreddit: string | null;
  /** sha256 of the username — raw identities are never stored. */
  author_ref: string | null;
  title: string | null;
  body: string | null;
  posted_at: string | null;
  /** For comments: the parent POST's external_id (Reddit-style threading);
   * NULL for posts. */
  parent_external_id: string | null;
  /** For comments: the parent post title, parsed from the synthetic
   * "/u/X on <post title>" comment title. NULL for posts. */
  parent_title: string | null;
}

export type NormalizedRedditItem =
  | {
      kind: 'mention';
      mention: NormalizedRedditMention;
      /**
       * RAW title + body for term-containment checks. Distinct from the
       * stored fields: a comment's raw title is the actor's synthetic
       * `"/u/X on <post title>"` (nulled in `mention.title`), so containment
       * against rawText keeps replies under a brand-titled post.
       */
      rawText: string;
    }
  | { kind: 'community'; community: VerifiedCommunity }
  | { kind: 'skipped'; dataType: string };

/** Best-effort string field read from an untyped dataset item. */
function str(item: Record<string, unknown>, key: string): string | null {
  const value = item[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(item: Record<string, unknown>, key: string): number | null {
  const value = item[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 'r/Supplements' | '/r/supplements/' | 'Supplements' -> 'Supplements'. */
function stripSubredditPrefix(raw: string | null): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/^\/?r\//i, '').replace(/\/+$/, '').trim();
  return stripped === '' ? null : stripped;
}

/** 'u/someone' | '/user/someone' | 'someone' -> 'someone'. */
function stripUsernamePrefix(raw: string | null): string | null {
  if (!raw) return null;
  const stripped = raw
    .replace(/^\/?u(ser)?\//i, '')
    .replace(/\/+$/, '')
    .trim();
  return stripped === '' ? null : stripped;
}

function toIso(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * The parent POST's base-36 id for a comment. Prefer an explicit actor field
 * when present (postId/link/parent variants differ across builds); the
 * guaranteed fallback is the comment permalink, which always embeds
 * `/comments/<postId>/<slug>/<commentId>/`. Reddit thing-ids may carry a
 * `t3_` prefix — strip it.
 */
function parseParentPostId(
  item: Record<string, unknown>,
  url: string | null,
): string | null {
  const field =
    str(item, 'postId') ??
    str(item, 'parentPostId') ??
    str(item, 'linkId') ??
    str(item, 'link_id');
  if (field) return field.replace(/^t3_/i, '');
  if (url) {
    const match = url.match(/\/comments\/([a-z0-9]+)/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * The parent post title from the actor's synthetic comment title
 * ("/u/username on <post title>"). Returns the captured title, else null.
 */
function parseParentTitle(rawTitle: string | null): string | null {
  if (!rawTitle) return null;
  const match = rawTitle.match(/^\/?u\/\S+ on (.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Normalizes one reddit-scraper-lite dataset item, keyed on its `dataType`
 * discriminator (post | comment | community | user). Field reads are
 * defensive — the actor's shapes differ per type and drift across builds —
 * and unknown/unusable items are logged + skipped, never thrown on.
 */
export function normalizeRedditItem(raw: unknown): NormalizedRedditItem {
  if (raw === null || typeof raw !== 'object') {
    console.warn('[BrandPresence] Skipping non-object Reddit dataset item');
    return { kind: 'skipped', dataType: 'unknown' };
  }
  const item = raw as Record<string, unknown>;
  const dataType = str(item, 'dataType')?.toLowerCase() ?? 'unknown';

  if (dataType === 'post' || dataType === 'comment') {
    const externalId = str(item, 'parsedId') ?? str(item, 'id');
    if (!externalId) {
      console.warn(
        `[BrandPresence] Skipping ${dataType} item without an id (url=${str(item, 'url') ?? 'n/a'})`,
      );
      return { kind: 'skipped', dataType };
    }
    const username = stripUsernamePrefix(str(item, 'username'));
    // Reddit's JSON HTML-escapes text (`I&#39;ve`); store it decoded.
    const rawTitle = decodeHtmlEntities(str(item, 'title'));
    const body = decodeHtmlEntities(str(item, 'body') ?? str(item, 'text'));
    const url = str(item, 'url');
    const isComment = dataType === 'comment';
    return {
      kind: 'mention',
      mention: {
        external_id: externalId,
        data_type: dataType,
        url,
        subreddit: stripSubredditPrefix(
          str(item, 'parsedCommunityName') ?? str(item, 'communityName'),
        ),
        author_ref: username ? hashValue(username) : null,
        title: dataType === 'post' ? rawTitle : null,
        body,
        posted_at: toIso(str(item, 'createdAt')),
        parent_external_id: isComment ? parseParentPostId(item, url) : null,
        parent_title: isComment ? parseParentTitle(rawTitle) : null,
      },
      rawText: `${rawTitle ?? ''}\n${body ?? ''}`,
    };
  }

  if (dataType === 'community') {
    const name = stripSubredditPrefix(
      str(item, 'name') ?? str(item, 'displayName') ?? str(item, 'title'),
    );
    if (!name) {
      console.warn('[BrandPresence] Skipping community item without a name');
      return { kind: 'skipped', dataType };
    }
    return {
      kind: 'community',
      community: {
        name,
        title: str(item, 'title'),
        members: num(item, 'numberOfMembers') ?? num(item, 'members'),
        url: str(item, 'url'),
      },
    };
  }

  // 'user' items (and anything a future actor build adds) are not ingested.
  if (dataType !== 'user') {
    console.warn(
      `[BrandPresence] Skipping Reddit dataset item with unknown dataType "${dataType}"`,
    );
  }
  return { kind: 'skipped', dataType };
}

/**
 * Whether any name variant appears in the text on a word boundary
 * (case-insensitive). Drives the Run B/C scope promotion rule: a category
 * item that names the brand becomes scope=brand, relevance=pending.
 */
export function containsNameVariant(
  text: string | null | undefined,
  variants: string[],
): boolean {
  if (!text) return false;
  return variants.some((variant) => {
    const trimmed = variant.trim();
    if (trimmed === '') return false;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b fails around non-word chars (e.g. '@handle'); fall back to
    // lookaround-free boundaries on whitespace/punctuation edges.
    const pattern = /^[\w]/.test(trimmed) && /[\w]$/.test(trimmed)
      ? `\\b${escaped}\\b`
      : `(?:^|[^\\w])${escaped}(?:[^\\w]|$)`;
    return new RegExp(pattern, 'i').test(text);
  });
}

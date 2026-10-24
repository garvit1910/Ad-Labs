import {
  BRAND_PRESENCE_CONFIG,
  SUBREDDIT_INTENT_TERMS,
} from '@/lib/brand-presence/config';

/**
 * Input for the Apify actor trudax/reddit-scraper-lite (oAuCIx3ItNrs2okjQ).
 *
 * Generated from the actor's live OpenAPI definition
 * (GET /v2/acts/trudax~reddit-scraper-lite/builds/default/openapi.json,
 * build 5.5, fetched 2026-07-03) — NOT from the console UI field names.
 * Notable: `searchCommunityName` restricts a search to a SINGLE community
 * (one string, not a list), the post time filter is `time`, and refresh
 * cursors are `postDateLimit`/`commentDateLimit` date strings.
 */
export interface RedditScraperLiteInput {
  startUrls?: Array<{ url: string }>;
  skipComments?: boolean;
  skipUserPosts?: boolean;
  skipCommunity?: boolean;
  /** Task guardrail: always false — media links / upvotes stay disabled. */
  includeMediaLinks?: boolean;
  searches?: string[];
  /** Restrict the search to one community (e.g. 'Supplements'). */
  searchCommunityName?: string;
  ignoreStartUrls?: boolean;
  searchPosts?: boolean;
  searchComments?: boolean;
  searchCommunities?: boolean;
  searchUsers?: boolean;
  searchMedia?: boolean;
  sort?: '' | 'relevance' | 'hot' | 'top' | 'new' | 'rising' | 'comments';
  time?: 'all' | 'hour' | 'day' | 'week' | 'month' | 'year';
  includeNSFW?: boolean;
  maxItems?: number;
  maxPostCount?: number;
  maxComments?: number;
  maxCommunitiesCount?: number;
  maxUserCount?: number;
  /** Only retrieve posts published after this date (refresh cursor). */
  postDateLimit?: string;
  /** Only retrieve comments published after this date (refresh cursor). */
  commentDateLimit?: string;
  scrollTimeout?: number;
  proxy?: { useApifyProxy: boolean; apifyProxyGroups?: string[] };
  debugMode?: boolean;
}

/** Options shared by search-style runs. */
interface RefreshOptions {
  /** ISO date of the newest previously-ingested item; refresh runs fetch
   * newer-only with a reduced item cap. */
  refreshCursor?: string;
}

const BASE_INPUT: Pick<
  RedditScraperLiteInput,
  'includeMediaLinks' | 'skipUserPosts' | 'debugMode'
> = {
  includeMediaLinks: false,
  skipUserPosts: true,
  debugMode: false,
};

/**
 * Per-page caps for search-based runs. The actor's defaults (10 posts per
 * page, 10 comments per page) silently bottleneck a search run far below its
 * maxItems, so search builders raise them and let maxItems be the real cap
 * (verified against a live run: maxItems=300 still returned ~10 items with
 * the defaults in place).
 */
const SEARCH_PAGE_CAPS: Pick<
  RedditScraperLiteInput,
  'maxPostCount' | 'maxComments'
> = {
  maxPostCount: 100,
  maxComments: 50,
};

function applyRefresh(
  input: RedditScraperLiteInput,
  opts: RefreshOptions | undefined,
): RedditScraperLiteInput {
  if (!opts?.refreshCursor) return input;
  return {
    ...input,
    sort: 'new',
    postDateLimit: opts.refreshCursor,
    commentDateLimit: opts.refreshCursor,
    maxItems: Math.min(
      input.maxItems ?? BRAND_PRESENCE_CONFIG.refreshMaxItems,
      BRAND_PRESENCE_CONFIG.refreshMaxItems,
    ),
  };
}

/**
 * Run A — brand-name search (posts + comments) across all of Reddit. The full
 * (non-refresh) backfill runs once per sort in BRAND_SEARCH_SORTS: Reddit's
 * search recall for a niche brand name is poor, and different sort orders
 * surface different posts (e.g. 'top' all-time surfaces a review thread that
 * 'relevance' buries), so unioning the passes improves coverage.
 */
export function buildBrandSearchInput(
  nameVariants: string[],
  opts?: RefreshOptions,
  sort: RedditScraperLiteInput['sort'] = 'relevance',
): RedditScraperLiteInput {
  return applyRefresh(
    {
      ...BASE_INPUT,
      ...SEARCH_PAGE_CAPS,
      searches: nameVariants,
      searchPosts: true,
      searchComments: true,
      searchCommunities: false,
      searchUsers: false,
      searchMedia: false,
      skipCommunity: true,
      sort,
      time: 'all',
      maxItems: BRAND_PRESENCE_CONFIG.brandSearch.maxItems,
    },
    opts,
  );
}

/**
 * The Run B community-search terms: brand + competitors, plus the generic
 * buying-intent terms only when `subredditSearch.includeIntentTerms` is on.
 * The processor's containment gate reads the SAME list, so a search term can
 * never return items the gate is not looking for.
 */
export function subredditSearchTerms(
  brandName: string | null,
  competitors: string[],
): string[] {
  return [
    ...(brandName ? [brandName] : []),
    ...competitors,
    ...(BRAND_PRESENCE_CONFIG.subredditSearch.includeIntentTerms
      ? SUBREDDIT_INTENT_TERMS
      : []),
  ].filter((term, i, all) => term.trim() !== '' && all.indexOf(term) === i);
}

/**
 * Run B (a) — searches restricted to one subreddit (`subredditSearchTerms`).
 * `searchCommunityName` accepts a single community, so each subreddit source
 * is its own actor run. A null brand name means the brand name itself was
 * pruned as a homonym (see `redditTermPrune`).
 */
export function buildSubredditSearchInput(
  subredditName: string,
  brandName: string | null,
  competitors: string[],
  opts?: RefreshOptions,
): RedditScraperLiteInput {
  const searches = subredditSearchTerms(brandName, competitors);
  return applyRefresh(
    {
      ...BASE_INPUT,
      ...SEARCH_PAGE_CAPS,
      searches,
      searchCommunityName: normalizeSubredditName(subredditName),
      searchPosts: true,
      searchComments: true,
      searchCommunities: false,
      searchUsers: false,
      searchMedia: false,
      skipCommunity: true,
      sort: 'relevance',
      time: 'year',
      maxItems: BRAND_PRESENCE_CONFIG.subredditSearch.maxItems,
    },
    opts,
  );
}

/**
 * Run B (b) — light feed crawl of the subreddit's top-of-year posts. Only
 * runs while `subredditFeed.enabled` is on (off since 2026-10-19).
 */
export function buildSubredditFeedInput(
  subredditName: string,
): RedditScraperLiteInput {
  const name = normalizeSubredditName(subredditName);
  return {
    ...BASE_INPUT,
    startUrls: [{ url: `https://www.reddit.com/r/${name}/top/?t=year` }],
    skipCommunity: true,
    skipComments: false,
    maxPostCount: BRAND_PRESENCE_CONFIG.subredditFeed.maxPostCount,
    maxItems: BRAND_PRESENCE_CONFIG.subredditFeed.maxItems,
  };
}

/**
 * Run A threads phase — fetch the FULL comment tree for a set of already-stored
 * brand-scope posts, so every reply under a brand-mentioning post is captured
 * and shown Reddit-style (even replies that don't name the brand). One
 * startUrls run over the post permalinks; no search, no containment gate.
 */
export function buildBrandThreadsInput(
  postUrls: string[],
): RedditScraperLiteInput {
  return {
    ...BASE_INPUT,
    startUrls: postUrls
      .filter((url) => url.trim() !== '')
      .map((url) => ({ url })),
    ignoreStartUrls: false,
    skipCommunity: true,
    skipComments: false,
    maxPostCount: BRAND_PRESENCE_CONFIG.brandThreads.maxPosts,
    maxComments: BRAND_PRESENCE_CONFIG.brandThreads.maxCommentsPerPost,
    maxItems: BRAND_PRESENCE_CONFIG.brandThreads.maxItems,
  };
}

/**
 * Run C — competitor-name searches across Reddit. Feeds the Competitors
 * insights section. Deliberately competitor-name-only: the old
 * "best {category}" / "{category} recommendation" keyword searches dragged in
 * off-topic communities (r/asksg, r/qbittorrent) as false "category" mentions.
 */
export function buildCompetitorSearchInput(
  competitors: string[],
  opts?: RefreshOptions,
): RedditScraperLiteInput {
  const searches = [
    ...competitors,
    ...competitors.map((competitor) => `${competitor} review`),
  ].filter((term, i, all) => term.trim() !== '' && all.indexOf(term) === i);
  return applyRefresh(
    {
      ...BASE_INPUT,
      ...SEARCH_PAGE_CAPS,
      searches,
      searchPosts: true,
      searchComments: true,
      searchCommunities: false,
      searchUsers: false,
      searchMedia: false,
      skipCommunity: true,
      sort: 'relevance',
      time: 'year',
      maxItems: BRAND_PRESENCE_CONFIG.categorySearch.maxItems,
    },
    opts,
  );
}

/**
 * Subreddit-discovery verification run — resolves LLM-proposed category
 * keywords to REAL communities (with subscriber counts). Only the
 * communities toggle is on.
 */
export function buildCommunityVerifyInput(
  keywords: string[],
): RedditScraperLiteInput {
  return {
    ...BASE_INPUT,
    searches: keywords,
    searchPosts: false,
    searchComments: false,
    searchCommunities: true,
    searchUsers: false,
    searchMedia: false,
    maxCommunitiesCount: BRAND_PRESENCE_CONFIG.maxCommunitiesVerify,
    maxItems: BRAND_PRESENCE_CONFIG.maxCommunitiesVerify * 2,
  };
}

/** 'r/Supplements', '/r/supplements/', or a full URL -> 'Supplements'. */
export function normalizeSubredditName(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(www\.)?reddit\.com/i, '')
    .replace(/^\/?r\//i, '')
    .replace(/\/+$/, '')
    .trim();
}

/**
 * Layer 2 — Brand Presence shared types. The const arrays here are the single
 * source of truth for the CHECK constraints in drizzle/schema.ts, the zod
 * schemas in routes/processors, and the UI registry — keep them in sync with
 * the migration when adding values.
 */

export const BRAND_PRESENCE_SOURCE_TYPES = [
  'reddit_search',
  'reddit_subreddit',
  'reddit_category',
  'amazon_reviews',
  'google_maps_reviews',
  'instagram_comments',
  'tiktok_comments',
  'trustpilot',
  'onsite_reviews',
  'youtube',
  'x',
] as const;
export type BrandPresenceSourceType =
  (typeof BRAND_PRESENCE_SOURCE_TYPES)[number];

/** Source types the pipeline can actually scrape today (server-safe — the
 * icon/label registry in source-registry.ts is UI-only). */
export const LIVE_SOURCE_TYPES = [
  'reddit_search',
  'reddit_subreddit',
  'reddit_category',
  'amazon_reviews',
  'google_maps_reviews',
  'trustpilot',
  'x',
  'tiktok_comments',
  'instagram_comments',
] as const satisfies readonly BrandPresenceSourceType[];

/** Future source types seeded as coming_soon placeholder rows at discovery. */
export const COMING_SOON_SOURCE_TYPES = BRAND_PRESENCE_SOURCE_TYPES.filter(
  (type): type is BrandPresenceSourceType =>
    !(LIVE_SOURCE_TYPES as readonly string[]).includes(type),
);

export const BRAND_PRESENCE_SOURCE_STATUSES = [
  'available',
  'coming_soon',
  'pending',
  'running',
  'synced',
  'error',
] as const;
export type BrandPresenceSourceStatus =
  (typeof BRAND_PRESENCE_SOURCE_STATUSES)[number];

export const BRAND_PRESENCE_PROFILE_STATUSES = ['draft', 'confirmed'] as const;
export type BrandPresenceProfileStatus =
  (typeof BRAND_PRESENCE_PROFILE_STATUSES)[number];

/**
 * Brand Presence's role model. `self` = a brand the org owns, `competitor` = a
 * rival brand tracked for comparison. A profile's role is NULL when it predates
 * this model (legacy/agency portfolio profile). Roles are what separate Brand
 * Presence's connected brands from Competitor Analysis's ad-library
 * `tracked_competitors`; every connected brand is tagged and colour-coded by
 * role in the UI (`components/brand-presence/presence-role.tsx`).
 *
 * Capped orgs hold at most one `self` + one `competitor`; cap-exempt orgs hold
 * any number of each (see `brandPresenceBrandCapForOrg` in `./access`).
 */
export const PRESENCE_ROLES = ['self', 'competitor'] as const;
export type PresenceRole = (typeof PRESENCE_ROLES)[number];

/** Brand Presence's default cap: two brands (own + one competitor). */
export const BRAND_PRESENCE_MAX_BRANDS = 2;

/** UI label for each Brand Presence role. */
export const PRESENCE_ROLE_LABELS: Record<PresenceRole, string> = {
  self: 'My brand',
  competitor: 'Competitor',
};

export const MENTION_DATA_TYPES = ['post', 'comment', 'review'] as const;
export type MentionDataType = (typeof MENTION_DATA_TYPES)[number];

export const MENTION_PLATFORMS = [
  'reddit',
  'amazon',
  'google_maps',
  'x',
  'trustpilot',
  'tiktok',
  'instagram',
] as const;
export type MentionPlatform = (typeof MENTION_PLATFORMS)[number];

/** Mention platforms whose rows carry a 1–5 star rating (drives the star
 * badge in mention UIs). */
export const REVIEW_PLATFORMS: ReadonlySet<string> = new Set([
  'amazon',
  'google_maps',
  'trustpilot',
]);

/** Phrase-extraction lifecycle on brand_mentions.extraction_status. */
export const EXTRACTION_STATUSES = [
  'pending',
  'done',
  'skipped',
  'error',
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

// brand = names the user's own brand; competitor = names a tracked competitor
// brand; category = ambient category discussion (Run B communities + thread
// children). Precedence when a single item matches several: brand > competitor
// > category (see assignScope in mention-ingest.ts).
export const MENTION_SCOPES = ['brand', 'competitor', 'category'] as const;
export type MentionScope = (typeof MENTION_SCOPES)[number];

export const MENTION_RELEVANCES = [
  'pending',
  'relevant',
  'irrelevant',
  'not_required',
] as const;
export type MentionRelevance = (typeof MENTION_RELEVANCES)[number];

export const SUBREDDIT_CLASSIFICATIONS = ['core', 'adjacent'] as const;
export type SubredditClassification =
  (typeof SUBREDDIT_CLASSIFICATIONS)[number];

/**
 * Scrape run modes — derived from the source row's source_type.
 * 'competitor_search' is the mode for the reddit_category source type (kept as
 * the DB value for back-compat; it now listens for competitor names only, not
 * "best {category}" keyword searches — see reddit-actor-input.ts).
 */
export const SCRAPE_MODES = [
  'brand_search',
  'subreddit',
  'competitor_search',
] as const;
export type ScrapeMode = (typeof SCRAPE_MODES)[number];

/** Angle a mention takes toward a brand/category — extracted by the insights
 * job into mention.tags.insight. */
export const MENTION_ANGLES = [
  'pain_point',
  'praise',
  'wish',
  'question',
  'comparison',
  'other',
] as const;
export type MentionAngle = (typeof MENTION_ANGLES)[number];

export const MENTION_SENTIMENTS = [
  'positive',
  'negative',
  'neutral',
  'mixed',
] as const;
export type MentionSentiment = (typeof MENTION_SENTIMENTS)[number];

/** Per-mention VOC signal stored under brand_mentions.tags.insight by the
 * brand_presence_insights job. Competitors are matched against the profile's
 * competitor list where possible, plus any clearly-named new brands. */
export interface MentionInsight {
  competitors: string[];
  angle: MentionAngle;
  sentiment: MentionSentiment;
  gist: string;
  /** false = no standalone VOC value (deleted / bare reaction); stored but not
   * surfaced in the insight sections. Absent on pre-usable-flag rows = shown. */
  usable?: boolean;
  model: string;
  extractedAt: string;
}

/** Amazon review metadata stored under brand_mentions.tags.amazon. */
export interface AmazonMentionTag {
  asin: string;
  verifiedPurchase: boolean;
  vine: boolean;
  helpfulVotes: number | null;
  variant: string | null;
}

/** Google Maps review metadata stored under brand_mentions.tags.google.
 * ownerResponse* preserved so "unanswered negative review" is a queryable
 * signal; originalText kept when the body used the actor's translation. */
export interface GoogleMentionTag {
  placeId: string | null;
  likesCount: number | null;
  ownerResponseText?: string;
  ownerResponseAt?: string;
  originalText?: string;
  reviewImageCount?: number;
}

/**
 * X (Twitter) mention metadata stored under brand_mentions.tags.x. `tier`
 * records which saved-search query surfaced the tweet: 'handle' results
 * (someone tagged @brand) skip the relevance gate; 'variant' keyword results
 * are always gated. Engagement counts are display metadata only — theme
 * clustering stays count-based like every other platform.
 */
export interface XMentionTag {
  tier: 'handle' | 'variant';
  /** The actor-echoed search term that matched (variant tier attribution —
   * drives the per-query kill-rate stats). */
  matchedTerm?: string;
  likes: number | null;
  retweets: number | null;
  replies: number | null;
  quotes: number | null;
  views: number | null;
  authorFollowers: number | null;
  lang: string | null;
}

/** brand_mentions.tags.trustpilot — companyReply* preserved so "unanswered negative
 * review" stays a queryable signal; reply text is NEVER sent to extraction. */
export interface TrustpilotMentionTag {
  verified: boolean;
  country?: string;
  companyReplyText?: string;
  companyReplyAt?: string;
  likes?: number | null;
}

/**
 * brand_mentions.tags.tiktok — the parent-video linkage (the mention's url
 * points at the video; the caption rides parent_title) plus display-only
 * engagement. Engagement counts are display metadata only — theme clustering
 * stays count-based like every other platform.
 */
export interface TikTokMentionTag {
  videoId: string;
  videoUrl: string | null;
  likes: number | null;
  replyCount: number | null;
  /** Reply-to-a-comment (threads often carry the real complaint). data_type
   * stays 'comment' either way — the video is the thread anchor. */
  isReply: boolean;
  parentCommentId?: string;
}

/**
 * brand_mentions.tags.instagram — the parent-post linkage (the mention's url
 * is the comment's own permalink; the caption rides parent_title) plus
 * display-only engagement. kind keeps posts and reels uniformly handled —
 * one registry, one selection policy, one tag shape. Engagement counts are
 * display metadata only — theme clustering stays count-based like every
 * other platform.
 */
export interface InstagramMentionTag {
  /** Parent post's shortcode (= brand_presence_instagram_posts.post_id). */
  postId: string;
  postUrl: string | null;
  kind: 'post' | 'reel';
  likes: number | null;
  replyCount: number | null;
}

/** Shape of brand_mentions.tags once the insights job has run. */
export interface MentionTags {
  insight?: MentionInsight;
  amazon?: AmazonMentionTag;
  google?: GoogleMentionTag;
  x?: XMentionTag;
  trustpilot?: TrustpilotMentionTag;
  tiktok?: TikTokMentionTag;
  instagram?: InstagramMentionTag;
  /** Straggler-sweep counter: how many times relevance-finalize re-batched
   * this still-pending mention after its verdict was dropped. At the cap the
   * mention defaults to irrelevant (see relevance-finalize.ts). */
  gateSweeps?: number;
  [key: string]: unknown;
}

/** One atomic extracted signal (phrase near-verbatim, paraphrase normalized). */
export interface ExtractedPhraseEntry {
  phrase: string;
  paraphrase: string;
}

/** Raw structured output of the extract pass, stored in
 * brand_mentions.extraction (audit/debug + per-mention classification UI). */
export interface MentionExtraction {
  /** -1..1 numeric sentiment. */
  sentiment: number;
  pains: ExtractedPhraseEntry[];
  desires: ExtractedPhraseEntry[];
  objections: ExtractedPhraseEntry[];
  praise: ExtractedPhraseEntry[];
  /** Substring-validated verbatim quotes. */
  quotes: string[];
  model: string;
  extractedAt: string;
}

/**
 * Atomic VOC phrase kinds. pain/desire/objection/praise cluster into themes;
 * quote rows are word-for-word verbatims that attach to themes via their
 * parent mention and are never clustered.
 */
export const PHRASE_KINDS = [
  'pain',
  'desire',
  'objection',
  'praise',
  'quote',
] as const;
export type PhraseKind = (typeof PHRASE_KINDS)[number];

/** Clusterable phrase kinds (= theme kinds). */
export const THEME_KINDS = ['pain', 'desire', 'objection', 'praise'] as const;
export type ThemeKind = (typeof THEME_KINDS)[number];

/** Phrases/themes cover the user's brand + ambient category talk only;
 * competitor-scope mentions get tags.insight treatment, not phrases. */
export const PHRASE_SCOPES = ['brand', 'category'] as const;
export type PhraseScope = (typeof PHRASE_SCOPES)[number];

/** Amazon marketplace domain codes supported by the Axesso reviews actor
 * (its domainCode input) — mirror of the products.marketplace CHECK. */
export const AMAZON_MARKETPLACES = [
  'com',
  'ca',
  'co.uk',
  'in',
  'de',
  'fr',
  'it',
  'es',
  'co.jp',
  'com.au',
  'com.br',
  'nl',
  'se',
  'com.mx',
  'ae',
] as const;
export type AmazonMarketplace = (typeof AMAZON_MARKETPLACES)[number];

export const PRODUCT_REVIEW_SCRAPE_STATUSES = [
  'not_started',
  'queued',
  'running',
  'done',
  'error',
] as const;
export type ProductReviewScrapeStatus =
  (typeof PRODUCT_REVIEW_SCRAPE_STATUSES)[number];

export interface BrandPresenceProfile {
  id: string;
  organization_id: string;
  website_url: string;
  brand_name: string;
  name_variants: string[];
  product_description: string | null;
  category: string | null;
  competitors: string[];
  status: BrandPresenceProfileStatus;
  /** `self` = the org's own brand, `competitor` = the tracked competitor
   * brand. NULL = legacy profile predating the 2-brand model. */
  presence_role: PresenceRole | null;
  amazon_marketplace: AmazonMarketplace;
  amazon_storefront_url: string | null;
  amazon_product_urls: string[];
  meta: ProfileMeta;
  created_at: string;
  updated_at: string;
}

/** Crash-resume state for the subreddit-discovery job (phases in order). */
export interface SubredditDiscoveryCheckpoint {
  phase: 'propose' | 'verify' | 'select';
  candidates?: string[];
  keywords?: string[];
  runId?: string | null;
  datasetId?: string | null;
  runStartedAt?: string | null;
  verifiedCommunities?: VerifiedCommunity[];
}

export interface ProfileMeta {
  subredditDiscovery?: SubredditDiscoveryCheckpoint;
  /** Discovery-step outcome flags. `homepageBlocked` = the site blocked both
   * the plain fetch and the Apify fallback, so the draft was seeded from the
   * domain and needs manual confirmation. */
  discovery?: { homepageBlocked?: boolean };
  /** Per-term Reddit kill rates (`redditTermPrune`), rewritten by the
   * relevance processor after each pass over Reddit mentions. */
  redditTermStats?: RedditTermStatsSnapshot;
  [key: string]: unknown;
}

/** Kill rate of one Reddit search term over the mentions only it matched. */
export interface RedditTermStat {
  decided: number;
  relevant: number;
  killRate: number;
  /** Dropped from Reddit searches and gates while true. */
  flagged: boolean;
}

export interface RedditTermStatsSnapshot {
  /** Keyed by name variant (brand-scope mentions). */
  variants: Record<string, RedditTermStat>;
  /** Keyed by competitor name (competitor-scope mentions). */
  competitors: Record<string, RedditTermStat>;
  computedAt: string;
}

/** A real Reddit community confirmed by the verification actor run. */
export interface VerifiedCommunity {
  name: string;
  title: string | null;
  members: number | null;
  url: string | null;
}

/** In-flight scrape checkpoint, present in source.meta only while running. */
export interface SourceSyncCheckpoint {
  /** sha256 of (sourceType|mode|refresh|input) — discards stale checkpoints
   * when the source config changed between attempts. */
  scopeKey: string;
  startedAt: string;
  /**
   * Reddit: 'single' for Run C (competitor_search); Run A advances 'search'
   * -> 'threads' (fetch full comment trees for stored brand posts); Run B
   * advances 'search' -> 'feed'. Google Maps reviews: 'backfill_low'
   * (lowestRanking) optionally advances to 'topup_high' (highestRanking) when
   * the place has more reviews than the cap; cursor refreshes run 'refresh'.
   * X: 'handle' -> 'variants'. Trustpilot: 'backfill_negative' (1–2★ Run A,
   * skipped when reviewsCount <= backfillMaxItems) -> 'backfill_full' (Run B,
   * unfiltered); cursor refreshes run 'refresh'. TikTok (two-hop):
   * 'enumerate' (Hop 1 profile enumeration -> video registry + batch plan)
   * -> 'harvest' (sequential Hop 2 comment batches); backfill and refresh
   * run the same two phases — the refresh flag only changes the planner.
   * Instagram (two-hop, ONE multi-mode actor): backfill runs
   * 'enumerate_posts' -> 'enumerate_reels' -> 'harvest' (reels are a
   * separate actor resultsType); refresh prepends 'recheck' (fresh
   * commentsCounts for the tracked comment-rich posts) and the enumerate
   * phases carry the onlyPostsNewerThan floor.
   */
  phase:
    | 'single'
    | 'search'
    | 'feed'
    | 'threads'
    | 'backfill_low'
    | 'topup_high'
    | 'backfill_negative'
    | 'backfill_full'
    | 'refresh'
    | 'handle'
    | 'variants'
    | 'enumerate'
    | 'harvest'
    | 'recheck'
    | 'enumerate_posts'
    | 'enumerate_reels';
  runId: string | null;
  datasetId: string | null;
  runStartedAt: string | null;
  /** Items already ingested from the current dataset (mid-dataset resume). */
  datasetOffset: number;
  /** Run A only: which brandSearchSorts pass the search phase is on (multi-sort
   * recall). Advances 0..n across sequential actor runs before the threads
   * phase; unused by Runs B/C. */
  searchSortIndex?: number;
  /** Reddit only: the homonym terms this sync dropped from its searches and
   * containment gate (`redditTermPrune`). Fixed when the checkpoint is
   * created, so a resume never switches term lists mid-sync; absent on
   * checkpoints written before pruning existed (= nothing dropped). */
  prunedTerms?: { variants: string[]; competitors: string[] };
  /** R2 raw page counter. */
  page: number;
  /** Newest posted_at seen so far — committed to meta.cursor at finalize
   * (kept in the checkpoint so budget yields mid-ingest don't lose it). */
  maxPostedAt?: string | null;
  /** TikTok harvest only: the Hop-2 batch plan computed once after
   * enumeration (deterministic mid-run resume; ≤ ~35 selected videos). */
  tiktokBatches?: Array<{
    videoIds: string[];
    urls: string[];
    /** ⚠️ Replies-included per-post cap (actor semantics), min 1. */
    commentsPerPost: number;
  }>;
  /** Next unprocessed batch. Advances ONLY after the batch's dataset is
   * fully ingested and its per-video baselines committed — that ordering is
   * the partial-failure guarantee (a failed batch never advances state). */
  tiktokBatchIndex?: number;
  /** Per-video dataset-item yield for the CURRENT batch (crash-safe across
   * mid-dataset budget yields; cleared when the batch commits). Yield counts
   * items ATTRIBUTABLE to the video (kept + owner-dropped + short) — any
   * item proves the scrape covered it. */
  tiktokBatchYields?: Record<string, number>;
  /** Instagram harvest only: the platform-generic twins of the tiktok*
   * batch trio above (same contract — plan computed once after enumeration;
   * the index advances ONLY after a batch's dataset is fully ingested and
   * its per-post baselines committed; yields credit any attributable item
   * as coverage evidence). postIds are Instagram shortcodes. */
  harvestBatches?: Array<{
    postIds: string[];
    urls: string[];
    /** Per-post (per-URL) comment cap, min 1, actor max 50. */
    commentsPerPost: number;
  }>;
  harvestBatchIndex?: number;
  harvestBatchYields?: Record<string, number>;
  /** Instagram run stats accumulated across phases/batches for
   * meta.instagram.lastRun (generic twins of the tiktok* counters below). */
  harvestPostsEnumerated?: number;
  harvestPostsScraped?: number;
  /** TikTok run stats accumulated across phases/batches for
   * meta.tiktok.lastRun. */
  tiktokVideosEnumerated?: number;
  tiktokVideosScraped?: number;
  /** filtered = items dropped by the ingest term-containment gate (Reddit
   * fuzzy search returns items whose text never names the query). shortText
   * = X tweets / TikTok comments stored extraction-skipped for having no
   * real words. ownerDropped = TikTok comments authored by the profile owner
   * (brand replying to fans is not voice-of-customer). */
  counts: {
    upserted: number;
    skipped: number;
    filtered?: number;
    shortText?: number;
    ownerDropped?: number;
  };
}

/**
 * Resolved Google Maps listing stored on the google_maps_reviews source row
 * (one place per source). Written by the resolve probe; `confirmedAt` is the
 * founder gate — no full scrape runs without it. `degraded` = the probe
 * returned no items (zero-review listing) so metadata came from the URL.
 */
export interface GooglePlaceMeta {
  /** The founder-pasted Maps URL — also the actor's startUrl. */
  url: string;
  placeId: string | null;
  title: string | null;
  address: string | null;
  totalScore: number | null;
  reviewsCount: number | null;
  resolvedAt: string;
  degraded: boolean;
  confirmedAt?: string;
  /**
   * The resolved listing title did not match any of the profile's name
   * variants (`placeMatchesBrand`). A Maps URL resolves cleanly to whatever
   * listing it points at, and Maps reviews skip the relevance LLM entirely,
   * so a mismatch withholds AUTO-confirm and parks the card on the founder.
   * Never blocks a manual confirm — a listing may legitimately carry a legal
   * entity name the brand variants don't cover.
   */
  brandMismatch?: boolean;
}

/** In-flight resolve-probe checkpoint (source.meta.resolve) — persisted
 * immediately after startRun so a yielded job polls the same billable run. */
export interface GooglePlaceResolveCheckpoint {
  runId: string;
  datasetId: string;
  runStartedAt: string;
  startedAt: string;
}

/** Per-variant-query relevance-gate outcome stats for the X source, keyed by
 * the exact search term. Recomputed after each relevance pass; a flagged term
 * means the name is too generic for X keyword search and only the handle
 * query is trustworthy — surfaced in the X panel. */
export interface XQueryStats {
  [term: string]: {
    decided: number;
    relevant: number;
    killRate: number;
    flagged: boolean;
  };
}

/**
 * X (Twitter) source configuration stored on the x source row. `confirmedAt`
 * is the founder gate (mirrors GooglePlaceMeta.confirmedAt) — the scrape
 * processor refuses to run without it. `handle` is null on the
 * "no X handle / name-search only" path.
 */
export interface XSourceMeta {
  handle: string | null;
  nameSearchOnly: boolean;
  confirmedAt: string;
  queryStats?: XQueryStats;
  /** Last completed scrape's counts — zeroItems drives the "X is quiet for
   * this brand" panel state (a zero-item success is NOT actor breakage for
   * small brands). */
  lastRun?: {
    finishedAt: string;
    upserted: number;
    filtered: number;
    skippedShort: number;
    zeroItems: boolean;
  };
}

/** trustpilot only: the resolved/confirmed Trustpilot business unit (one per source).
 * confirmedAt is the hard founder gate — the reviews processor refuses to scrape
 * without it (mirrors GooglePlaceMeta.confirmedAt; the confirm route is the sole writer).
 * degraded = probe could not verify the page (no company block / zero items). */
export interface TrustpilotPageMeta {
  url: string;                 // canonical https://www.trustpilot.com/review/<domain>
  domain: string;              // EXACT unit slug the actor keys on — may include
                               // 'www.' ('www.x.com' and 'x.com' are DIFFERENT units)
  title: string | null;        // company display name
  trustScore: number | null;   // 1.0–5.0
  reviewsCount: number | null;
  starDistribution?: Partial<Record<1 | 2 | 3 | 4 | 5, number>>;
  verifiedDomain?: string | null; // company block's own domain (wrong-company check)
  resolvedAt: string;
  degraded: boolean;
  confirmedAt?: string;
}

/** trustpilot only: one fallback-search candidate business unit. */
export interface TrustpilotCandidate {
  url: string;
  /** EXACT unit slug (may include 'www.') — becomes the scrape target verbatim. */
  domain: string;
  name: string | null;
  trustScore: number | null;
  reviewsCount: number | null;
}

/** trustpilot only: in-flight resolve checkpoint — persisted immediately after
 * startRun so a yielded job resumes the SAME billable run. mode drives the
 * ladder: probe → probe_www (the `www.<seed>` retry — units can be keyed on
 * the www variant) → search | degraded. */
export interface TrustpilotResolveCheckpoint {
  mode: 'probe' | 'probe_www' | 'search';
  runId: string;
  datasetId: string;
  runStartedAt: string;
  startedAt: string;
}

/** trustpilot only: all Trustpilot source state, namespaced like SourceMeta.x. */
export interface TrustpilotSourceMeta {
  page?: TrustpilotPageMeta;
  resolve?: TrustpilotResolveCheckpoint;
  candidates?: TrustpilotCandidate[];  // fallback picker; cleared on confirm
  notOnPlatform?: boolean;             // "we're not on Trustpilot" dismissal — meta, never a status
  dismissedAt?: string;
  lastRun?: { finishedAt: string; upserted: number; skipped: number; zeroItems: boolean };
}

/**
 * tiktok_comments only: the resolved profile card written by the Hop-1 probe.
 * `confirmedAt` is the hard founder gate (mirrors GooglePlaceMeta /
 * TrustpilotPageMeta; the confirm route is the sole writer — the harvest
 * processor refuses to scrape without it). `unavailable` is the EXPLICIT
 * terminal probe state for a private / not-found profile: meta, never an
 * error status, never retried (the panel offers "try a different username").
 * `degraded` = the probe returned no items and no error marker (e.g. a
 * zero-video account) — the founder may still confirm explicitly.
 */
export interface TikTokProfileCard {
  /** Normalized username, no '@'. */
  username: string;
  /** Canonical https://www.tiktok.com/@{username}. */
  url: string;
  displayName: string | null;
  followers: number | null;
  videoCount: number | null;
  resolvedAt: string;
  degraded: boolean;
  unavailable?: 'private' | 'not_found';
  /** The actor's own error string for the unavailable card (clear message
   * payload for the panel; never an alert). */
  unavailableMessage?: string;
  confirmedAt?: string;
}

/** tiktok_comments only: in-flight probe checkpoint — persisted immediately
 * after startRun so a yielded job resumes the SAME billable run. */
export interface TikTokResolveCheckpoint {
  runId: string;
  datasetId: string;
  runStartedAt: string;
  startedAt: string;
}

/** tiktok_comments only: all TikTok source state, namespaced like SourceMeta.x. */
export interface TikTokSourceMeta {
  /** Normalized handle from setup (probe input; survives a failed probe). */
  username?: string;
  profile?: TikTokProfileCard;
  resolve?: TikTokResolveCheckpoint;
  /** Last completed harvest's counts. A 40–60% skippedShort kill rate is
   * NORMAL for TikTok comments (emoji-only / one-word hype) — logged, never
   * alerted. zeroItems drives the "TikTok is quiet" panel state. */
  lastRun?: {
    finishedAt: string;
    refresh: boolean;
    videosEnumerated: number;
    videosPlanned: number;
    videosScraped: number;
    upserted: number;
    skipped: number;
    skippedShort: number;
    ownerDropped: number;
    zeroItems: boolean;
  };
}

/**
 * instagram_comments only: the resolved profile card written by the
 * details-mode probe. `confirmedAt` is the hard founder gate (mirrors
 * TikTokProfileCard; the confirm route is the sole writer — the harvest
 * processor refuses to scrape without it). `unavailable` is the EXPLICIT
 * terminal probe state: a private profile resolves a full details card
 * with private=true (its posts are unreadable), a missing one returns the
 * actor's `error: 'not_found'` marker item — meta, never an error status,
 * never retried (the panel offers "try a different username"). `degraded`
 * = the probe returned nothing classifiable — the founder may still
 * confirm explicitly.
 */
export interface InstagramProfileCard {
  /** Normalized lowercase username, no '@'. */
  username: string;
  /** Canonical https://www.instagram.com/{username}/. */
  url: string;
  fullName: string | null;
  followers: number | null;
  postsCount: number | null;
  resolvedAt: string;
  degraded: boolean;
  unavailable?: 'private' | 'not_found';
  /** Clear message payload for the panel; never an alert. */
  unavailableMessage?: string;
  confirmedAt?: string;
}

/** instagram_comments only: in-flight probe checkpoint — persisted
 * immediately after startRun so a yielded job resumes the SAME billable
 * run. */
export interface InstagramResolveCheckpoint {
  runId: string;
  datasetId: string;
  runStartedAt: string;
  startedAt: string;
}

/** instagram_comments only: all Instagram source state, namespaced like
 * SourceMeta.tiktok. */
export interface InstagramSourceMeta {
  /** Normalized username from setup (probe input; survives a failed probe). */
  username?: string;
  profile?: InstagramProfileCard;
  resolve?: InstagramResolveCheckpoint;
  /** When the last successful Hop-1 enumeration STARTED — the next
   * refresh's onlyPostsNewerThan floor (minus the configured overlap). */
  lastEnumeratedAt?: string;
  /** Last completed harvest's counts. A high skippedShort kill rate is
   * NORMAL for Instagram comments (emoji-only / tag-a-friend / bot links) —
   * logged, never alerted. zeroItems drives the "Instagram is quiet" panel
   * state. */
  lastRun?: {
    finishedAt: string;
    refresh: boolean;
    postsEnumerated: number;
    postsPlanned: number;
    postsScraped: number;
    upserted: number;
    skipped: number;
    skippedShort: number;
    ownerDropped: number;
    zeroItems: boolean;
  };
}

export interface SourceMeta {
  classification?: SubredditClassification;
  cursor?: { lastPostedAt: string };
  sync?: SourceSyncCheckpoint;
  /** google_maps_reviews only: the resolved/confirmed listing. */
  place?: GooglePlaceMeta;
  /** google_maps_reviews only: in-flight resolve-probe checkpoint. */
  resolve?: GooglePlaceResolveCheckpoint;
  /** x only: the founder-confirmed handle/search configuration. */
  x?: XSourceMeta;
  /** trustpilot only: the founder-confirmed business unit + resolve state. */
  trustpilot?: TrustpilotSourceMeta;
  /** tiktok_comments only: the founder-confirmed profile + probe state. */
  tiktok?: TikTokSourceMeta;
  /** instagram_comments only: the founder-confirmed profile + probe state. */
  instagram?: InstagramSourceMeta;
  /** storefrontBlocked = Amazon refused the storefront page fetch; the UI
   * switches to the paste-product-URLs path prominently. */
  flags?: { genericBrandName?: boolean; storefrontBlocked?: boolean };
  lastError?: { message: string; at: string };
  [key: string]: unknown;
}

export interface BrandPresenceSource {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_type: BrandPresenceSourceType;
  uri: string;
  label: string | null;
  status: BrandPresenceSourceStatus;
  meta: SourceMeta;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrandMention {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_id: string | null;
  platform: string;
  external_id: string;
  data_type: MentionDataType;
  scope: MentionScope;
  url: string | null;
  subreddit: string | null;
  author_ref: string | null;
  title: string | null;
  body: string | null;
  posted_at: string | null;
  relevance: MentionRelevance;
  relevance_confidence: number | null;
  /** Star rating for review platforms (Amazon 1–5); NULL for Reddit. */
  rating: number | null;
  extraction_status: ExtractionStatus;
  raw_ref: string | null;
  /** For comments: the external_id of the parent post (for Reddit-style
   * threading). NULL for posts. Parsed from the comment permalink. */
  parent_external_id: string | null;
  /** For comments: the parent post's title, parsed from the actor's synthetic
   * "/u/X on <post title>" comment title. Display context for standalone
   * comments (a comment's own stored title stays NULL). */
  parent_title: string | null;
  created_at: string;
  /** Present once the insights job has annotated the mention. */
  tags?: MentionTags;
  /** Present once the extract pass has decomposed the mention. */
  extraction?: MentionExtraction | null;
}

/** In-flight per-product review-scrape checkpoint (product.meta.sync). */
export interface ProductSyncCheckpoint {
  /** sha256 of (asin|marketplace|refresh|caps) — discards stale checkpoints
   * when the product config changed between attempts. */
  scopeKey: string;
  startedAt: string;
  /** recent = most-recent reviews pass; critical = 1-star pass (pain-dense
   * reviews survive the recency cap). Refresh runs skip the critical pass. */
  phase: 'recent' | 'critical';
  runId: string | null;
  datasetId: string | null;
  runStartedAt: string | null;
  datasetOffset: number;
  /** R2 raw page counter. */
  page: number;
  /** Newest review posted_at seen — committed to review_cursor at finalize. */
  maxPostedAt?: string | null;
  counts: { upserted: number; skipped: number };
}

export interface ProductMeta {
  sync?: ProductSyncCheckpoint;
  lastError?: { message: string; at: string };
  [key: string]: unknown;
}

export interface BrandPresenceProduct {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_id: string | null;
  marketplace: AmazonMarketplace;
  asin: string;
  url: string | null;
  title: string | null;
  rating: number | null;
  review_count: number | null;
  selected: boolean;
  review_scrape_status: ProductReviewScrapeStatus;
  reviews_ingested: number;
  review_cursor: string | null;
  meta: ProductMeta;
  first_seen_at: string;
  updated_at: string;
}

/**
 * One row of the TikTok per-video registry (brand_presence_tiktok_videos) —
 * the Hop-1 "treasure map" that budgets Hop-2 comment harvests. Two counters
 * carry the diff-driven refresh: `comment_count` is the latest enumerated
 * value (updated on every Hop-1 pass), `baseline_comment_count` is the delta
 * baseline — set to the first-seen count on insert and advanced to the
 * plan-time count ONLY when the video's comments were actually scraped
 * (delta = comment_count − baseline_comment_count). Partial Hop-2 failure
 * never advances the baseline for the failed videos.
 */
export interface BrandPresenceTikTokVideo {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_id: string | null;
  video_id: string;
  url: string;
  /** Hop-1 caption ('text') — the normalize-time parent_title source (Hop-2
   * comment items carry no caption). */
  caption: string | null;
  posted_at: string | null;
  comment_count: number;
  baseline_comment_count: number;
  comments_ingested: number;
  last_enumerated_at: string | null;
  last_scraped_at: string | null;
  meta: Record<string, unknown>;
  first_seen_at: string;
  updated_at: string;
}

export interface BrandPresencePhrase {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  mention_id: string;
  kind: PhraseKind;
  phrase: string;
  paraphrase: string | null;
  sentiment: number | null;
  scope: PhraseScope;
  theme_id: string | null;
  created_at: string;
}

export interface BrandPresenceTheme {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  kind: ThemeKind;
  scope: PhraseScope;
  label: string;
  summary: string | null;
  is_catchall: boolean;
  frequency: number;
  mention_count: number;
  avg_sentiment: number | null;
  representative_phrase_ids: string[];
  cluster_run_id: string;
  created_at: string;
}

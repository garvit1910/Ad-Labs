/**
 * Layer 2 — Brand Presence cost caps and tuning knobs. Single source of truth:
 * every scrape job reads its item caps from here (per-source overrides may
 * live in source.meta.caps), so run costs are bounded in one place.
 */
export const BRAND_PRESENCE_CONFIG = {
  /** Run A backfill: one primary brand-name search across all of Reddit.
   * The second sort is a low-yield fallback, not an unconditional pass. */
  brandSearch: { maxItems: 300, fallbackMinKeptItems: 30 },
  /**
   * Sort orders the Run A brand backfill runs (one actor pass each, unioned)
   * to widen recall for niche brand names. 'top' surfaces the most-engaged
   * all-time posts (review/discussion threads) that 'relevance' can bury. Each
   * added sort is a cost multiplier on the brand search — 'new' is addable.
   */
  brandSearchSorts: ['relevance', 'top'] as const,
  /**
   * Run A threads phase: after the brand search, fetch the FULL comment tree
   * for each stored brand-scope post so replies show Reddit-style even when
   * they don't name the brand. One startUrls actor run over post permalinks.
   */
  brandThreads: { maxPosts: 10, maxItems: 100, maxCommentsPerPost: 25 },
  /**
   * Run B (a): community-restricted brand/competitor searches.
   * `includeIntentTerms` adds the generic SUBREDDIT_INTENT_TERMS ("review",
   * "recommend", "worth it") to the community search. OFF since 2026-10-19:
   * measured over 30 days of prod, category-scope Reddit items (what those
   * terms and the feed return) kept 2 of 342 stored; 3% all-time (30/1006).
   */
  subredditSearch: { maxItems: 80, includeIntentTerms: false },
  /**
   * Run B (b): light top-of-year feed crawl, first sync only. `enabled` OFF
   * since 2026-10-19 for the same reason as `includeIntentTerms` — the feed
   * has no containment gate, so it bills for ambient community posts the
   * relevance gate then discards.
   */
  subredditFeed: { enabled: false, maxPostCount: 20, maxItems: 40 },
  /** Run C: competitor-name search across all of Reddit (feeds Competitors). */
  categorySearch: { maxItems: 100 },
  /** Cursor-based refresh runs (future cron) use a smaller cap. */
  refreshMaxItems: 50,
  /** Minimum gap between completed user-triggered source syncs. */
  sync: { cooldownMs: 10 * 60 * 1000 },
  /** Dataset items fetched per page while ingesting a finished run. */
  datasetPageSize: 250,
  /** Apify run poll cadence. */
  pollIntervalMs: 15_000,
  /**
   * Wedged-run wall-clock ceiling. Staleness is otherwise state-based (keep
   * polling while Apify reports READY/RUNNING); this only catches genuinely
   * stuck runs — the reddit-scraper-lite actor finishes in ~1-4 min at our
   * caps. Every abandon path must abortRun() first (stops billing).
   */
  maxRunWallMs: 15 * 60 * 1000,
  /**
   * Reddit actor run options. `runMemoryMb` is the memory each
   * trudax/reddit-scraper-lite run starts with (override:
   * BRAND_PRESENCE_REDDIT_RUN_MEMORY_MB). Measured on the Apify account: the
   * actor bills an `actor-start-gb` event at $0.02 per GB of run memory, so
   * the actor default of 2 GB cost $0.04 per run before returning a result;
   * 1 GB halves that and the lite scraper completes within it at our caps.
   */
  reddit: { runMemoryMb: 1024 },
  /** Mentions per relevance LLM call. */
  relevanceBatchSize: 20,
  /** Tail-cost guard for one structured relevance response. */
  relevanceMaxOutputTokens: 3000,
  /**
   * Auto-promote subreddits where the brand actually gets mentioned into
   * tracked reddit_subreddit sources: a sub needs at least this many RELEVANT
   * brand mentions. `maxSubreddits` is the TOTAL tracked-community budget,
   * shared with LLM-selected rows, so selection + promotion can never fan out
   * beyond the paid onboarding cap.
   */
  autoPromote: { minRelevantBrandMentions: 2, maxSubreddits: 3 },
  /**
   * Conservative gate: a false-positive "relevant" pollutes the VOC corpus
   * and produces wrong ads downstream, so a mention is kept only when the
   * model marks it relevant with at least this confidence; everything else
   * (irrelevant verdicts AND low-confidence relevant verdicts) is dropped
   * to irrelevant.
   */
  irrelevantConfidenceFloor: 0.7,
  /**
   * Relevance cascade — the cost lever on the one Brand Presence call that
   * runs on the full model.
   *
   * Every batch is judged first by the cheap model. Only verdicts landing in
   * the AMBIGUOUS confidence band are re-judged by the full model; confident
   * keeps and confident kills are taken from the cheap pass and never touch
   * the expensive one. Because the escalated band gets TWO independent
   * judgments (and the full model's verdict wins), the conservative gate this
   * call exists to enforce is preserved, not relaxed.
   *
   * The band brackets `irrelevantConfidenceFloor` (0.7) — the threshold where
   * a mistake actually changes the outcome. A cheap `relevant: false` at 0.95
   * and a cheap `relevant: true` at 0.98 both decide the same way the full
   * model would; a verdict near the floor is where disagreement matters.
   *
   * Disable (`enabled: false`) to route every batch straight to the full
   * model — the exact pre-cascade behavior.
   */
  relevanceCascade: {
    enabled: true,
    /** Verdicts with confidence in [escalateFrom, escalateTo] are re-judged. */
    escalateFrom: 0.45,
    escalateTo: 0.9,
  },
  /** Run-A kill-rate flag: likely a generic brand name. */
  killRateFlagThreshold: 0.9,
  killRateMinSample: 20,
  /**
   * Per-term Reddit pruning. After each relevance pass, every name variant
   * and competitor gets a kill rate over the decided Reddit mentions it
   * EXCLUSIVELY matched (no other term of its list in the text). A term over
   * `flagThreshold` with at least `minSample` such mentions is dropped from
   * later Reddit searches and containment gates, so a homonym ("Ember",
   * "Quaker", "Bloomberg") stops billing for results the gate throws away.
   * Exclusive attribution is the recall guard: a relevant mention that also
   * names another term is still found by that other term's search.
   */
  redditTermPrune: { enabled: true, flagThreshold: 0.9, minSample: 20 },
  /** Subreddit discovery shape. */
  subredditCandidates: { min: 8, max: 15 },
  selectedSubreddits: { min: 1, max: 3 },
  categoryKeywords: { min: 5, max: 8 },
  maxCommunitiesVerify: 20,
  /**
   * Amazon Reviews adapter. The Axesso actor caps at 10 pages (~10 reviews
   * each — an Amazon limit), so maxPagesRecent=2 + criticalPass ≈ 30 reviews
   * per product per full pass. Each page bills per-result on Apify.
   */
  amazon: {
    /** Pages of most-recent reviews per product (10 reviews/page). */
    maxPagesRecent: 2,
    /** Second small pass for 1-star reviews so pain-dense reviews survive
     * the recency cap. Skipped on refresh runs. */
    criticalPass: { enabled: true, star: 'one_star', maxPages: 1 },
    /** Pages fetched on cursor refresh runs. */
    refreshMaxPages: 2,
    /** Hard cap on products tracked per brand (founder can deselect). */
    maxProductsPerBrand: 30,
    /** Review-scrape fan-out width: chains seeded per brand. There is no
     * global job limiter — the chain structure IS the throttle. */
    maxConcurrentReviewJobs: 3,
    /** Storefront-page fetch attempts before flagging storefrontBlocked. */
    storefrontFetchRetries: 2,
  },
  /**
   * Google Maps Reviews adapter (compass~google-maps-reviews-scraper,
   * pay-per-result). The backfill runs lowestRanking-first so 1-2★ reviews
   * survive the cap; when the place has more reviews than the cap a second
   * highestRanking top-up run keeps the "what people love" signal from
   * starving. Refresh runs are newest-first + reviewsStartDate cursor.
   */
  google: {
    /** Reviews per place on the initial lowestRanking backfill run. */
    backfillMaxReviews: 100,
    /** Top-up run size as a fraction of backfillMaxReviews. */
    topUpRatio: 0.5,
    /** Reviews per cursor refresh run. */
    refreshMaxReviews: 100,
    /** Actor results language. */
    language: 'en',
  },
  /**
   * X (Twitter) adapter (apidojo~twitter-scraper-lite, event-priced, no
   * minimum items per query). A scrape is two sequential runs because the
   * actor's maxItems is a GLOBAL per-run cap: the high-precision handle
   * query gets its own run so a generic name variant can never starve it,
   * then all name-variant queries batch into one run (includeSearchTerms
   * echoes the matching query per item for per-query attribution).
   */
  x: {
    /** Backfill cap for the handle-mention run (phase A). */
    handleSearch: { maxItems: 100 },
    /** Backfill cap for the batched name-variant run (phase B) — shared
     * across all variant queries in the run. */
    variantSearch: { maxItems: 100, maxVariants: 2 },
    /** Cursor refresh caps (since: bounds the window; caps stay shallow). */
    refresh: { handleMaxItems: 50, variantMaxItems: 50 },
    /** Tweets whose body (after stripping @mentions/URLs) is shorter than
     * this store extraction-skipped — "@brand 🔥" never reaches the LLM. */
    minBodyChars: 12,
    /** Per-variant-query kill-rate flag: a query whose gated mentions are
     * ~all irrelevant means that name is too generic for X keyword search
     * and only the handle query is trustworthy. */
    queryKillRate: { flagThreshold: 0.9, minSample: 10 },
  },
  /**
   * Trustpilot Reviews adapter (memo23~trustpilot-scraper-ppe, pay-per-event
   * ~$0.75/1k results). Explicit per-phase maxItems caps ARE the budget (no
   * per-brand dollar helper exists) — the founder-confirmed page is the
   * ownership gate, so reviews bypass the relevance LLM.
   */
  trustpilot: {
    /** Resolve probe: a handful of items carries the company block + stats. ~$0.004. */
    probeMaxItems: 5,
    /** Fallback candidate discovery via searchTerms. ~$0.015. */
    searchMaxItems: 20,
    /** Max candidates surfaced to the founder picker. */
    candidateCap: 5,
    /** Run A — up to 100 1–2★ reviews, defensive cap. */
    negativeBackfillMaxItems: 100,
    /** Run B — up to 100 unfiltered newest-first reviews. */
    backfillMaxItems: 100,
    /** Incremental refresh run (enrichment on, cheap). ~$0.075. */
    refreshMaxItems: 50,
  },
  /**
   * TikTok Comments adapter — TWO clockworks actors behind one source. Hop 1
   * (clockworks~tiktok-profile-scraper, ~$5/1k items) enumerates the
   * founder's own profile videos with per-video commentCount (the
   * budget-allocation signal); Hop 2 (clockworks~tiktok-comments-scraper,
   * ~$1/1k comments) harvests comments for the SELECTED video URLs only.
   * ⚠️ Hop 2's commentsPerPost cap INCLUDES replies and has an actor minimum
   * of 1 — every run sets it explicitly; never derive 0.
   * ⚠️ Every refresh re-runs Hop 1 (it IS the diff source); this is the
   * price of diff-driven refresh
   * (comment counts grow on OLD videos, so a date cursor cannot work here).
   */
  tiktok: {
    /** Hop 1 probe: a few latest videos carry the author card. ~$0.03. */
    probeMaxVideos: 5,
    /** Hop 1 full enumeration depth, latest-sorted. Never
     * shrink refresh enumeration below this — older videos would silently
     * fall out of delta tracking. */
    enumerationMaxVideos: 50,
    /** Backfill selection: top-N by commentCount ∪ M most recent, minus
     * videos under the comment floor (not worth an actor visit). ≤10 videos
     * per backfill. */
    selection: { topByComments: 7, recentCount: 3, minCommentFloor: 3 },
    /** Hop 2 backfill: at most 10 selected videos × 25 comments. Small
     * reply allowance — replies share the per-post cap. */
    backfill: { commentsPerVideo: 25, maxRepliesPerComment: 3 },
    refresh: {
      /** Re-scrape only videos whose enumerated commentCount grew ≥ this
       * over the baseline (count at last successful scrape / first sight). */
      deltaThreshold: 5,
      /** Per-video cap = clamp(ceil(delta × multiplier), minCap,
       * backfill.commentsPerVideo) — the actor can't fetch "only new
       * comments", so over-fetch slightly (the idempotent upsert absorbs
       * re-seen ones); the headroom also covers reply inflation inside the
       * replies-included cap. */
      capMultiplier: 1.5,
      minCap: 10,
    },
    /** Max postURLs per Hop-2 run — keeps runs short and a failed run's
     * blast radius small (per-video baselines commit per batch). */
    maxUrlsPerRun: 10,
    /** Comments with fewer real chars (after stripping @mentions/URLs) store
     * extraction-skipped. A 40–60% kill rate is NORMAL for TikTok — the
     * spammiest corpus in the system (emoji-only, "first", one-word hype). */
    minBodyChars: 12,
  },
  /**
   * Instagram Comments adapter — ONE official actor (apify/instagram-scraper,
   * $2.30/1k results, a "result" = one returned item in ANY mode) invoked in
   * different content-type modes behind one source: `details` confirmation
   * probe, `posts` + `reels` Hop-1 enumeration (reels are a SEPARATE
   * resultsType — both modes run every enumeration; the planner treats them
   * uniformly), `comments` Hop-2 harvest. Same two-hop discipline as TikTok:
   * enumeration is the treasure map; never send all posts to Hop 2.
   * ⚠️ Comments mode is hard-capped by the actor at 50 comments per post —
   * perPostCommentCap can never exceed it.
   * Refresh is CHEAPER than TikTok's full re-enumeration: the recheck run
   * re-reads only the tracked comment-rich posts (~1 result per post URL,
   * verified live), and the enumeration runs carry onlyPostsNewerThan (UTC)
   * so already-known old posts are not re-billed. Backfill is bounded to 30
   * enumeration items per mode and at most 12 selected posts.
   */
  instagram: {
    /** Details-mode resolve probe: one item is the whole profile card. */
    probeMaxItems: 1,
    /** Hop-1 enumeration depth PER MODE (one posts run + one reels run). */
    enumerationMaxPosts: 30,
    /** Refresh recheck depth: tracked comment-rich posts re-read for fresh
     * commentsCount (posts mode over direct post URLs, resultsLimit 1). */
    recheckMaxPosts: 15,
    /** Refresh enumeration floor = lastEnumeratedAt minus this many days
     * (UTC day-sliced) — overlap absorbs clock skew; the idempotent
     * registry upsert absorbs the re-seen posts. */
    refreshOverlapDays: 2,
    /** Backfill selection: top-N by commentCount ∪ M most recent, minus
     * posts under the comment floor (not worth an actor visit). ≤12 posts
     * per backfill. */
    selection: { topByComments: 8, recentCount: 4, minCommentFloor: 3 },
    /** Per-post (per-URL) comment cap — THE ACTOR'S HARD MAX; never raise.
     * Instagram may return fewer than 15 on some posts. */
    perPostCommentCap: 20,
    refresh: {
      /** Re-scrape only posts whose fresh commentCount grew ≥ this over
       * the baseline (count at last successful scrape / first sight). */
      deltaThreshold: 5,
      /** Per-post cap = clamp(ceil(delta × multiplier), minCap,
       * perPostCommentCap) — the actor can't fetch "only new comments", so
       * over-fetch slightly (the idempotent upsert absorbs re-seen ones). */
      capMultiplier: 1.5,
      minCap: 10,
    },
    /** Max post URLs per Hop-2 run. Comment items carry per-item postUrl
     * attribution and resultsLimit is per-URL (both pinned live), so
     * batching is provenance-safe; small batches keep a failed run's blast
     * radius small. */
    maxUrlsPerRun: 10,
    /** Comments with fewer real chars (after stripping @mentions/URLs)
     * store extraction-skipped. High kill rates are NORMAL for Instagram —
     * emoji-only, tag-a-friend chains, bot links. Logged, never alerted. */
    minBodyChars: 12,
  },
  /** Phrase-extraction pass (replaces the old insights pass). */
  extract: {
    /** Mentions per extraction LLM call. */
    batchSize: 20,
    /** Hard onboarding ceiling across all platforms. */
    maxPerOnboarding: 1500,
    /** Backward-compatible per-wave ceiling; the platform budgets below are
     * the stronger constraint used by the queue. */
    maxPerWave: 1500,
    /** Platform-stratified allocation. Raw mentions beyond these limits stay
     * stored but skip the deep LLM pass. */
    platformBudgets: {
      reddit: 300,
      amazon: 200,
      google_maps: 200,
      x: 200,
      trustpilot: 200,
      tiktok: 200,
      instagram: 200,
    },
    /** Candidate pool per platform before deterministic scope/text diversity. */
    candidatePoolMultiplier: 3,
    /** Mention body chars sent to the model. */
    maxBodyChars: 1500,
    /** Tail-cost guard for one structured extraction response. */
    maxOutputTokens: 6000,
    /** Phrases embedded per job run (one embedding wave). */
    maxEmbedPerRun: 500,
  },
  /** Theme clustering over phrase embeddings — grouping is by MEANING into a
   * corpus-adaptive number of angles, never a fixed taxonomy. Thresholds are
   * placeholders until anchored against real pairwise-cosine distributions
   * (scripts/brand-presence-cosine-distribution.ts). */
  cluster: {
    /** Minimum gap between completed user-triggered re-analysis runs. */
    reanalyzeCooldownMs: 10 * 60 * 1000,
    /** Families below this size are leftovers for the attach/catch-all pass. */
    minClusterSize: 2,
    /** Partitions at/below this many clusterable phrases group via ONE
     * cheap-model call instead of embedding clustering (embedding fallback
     * on LLM failure — vectors always exist). */
    smallCorpusMaxPhrases: 28,
    /** Adaptive UPGMA angle target: clamp(round(sqrt(N/2)), min, max). */
    targetAngles: { min: 3, max: 8 },
    /** Keep merging past the target while best mean cosine >= this
     * (near-duplicate clusters always collapse). */
    softCosine: 0.62,
    /** Never merge two clusters whose mean cosine is below this. Anchored on
     * the Magic Spoon dev distribution (2026-07): p50 of all pain pairs is
     * ~0.25-0.29, so 0.40 mean keeps merged angles clearly above ambient
     * relatedness while converging toward the target count. */
    mergeFloor: 0.4,
    /** Leftover phrases attach to the nearest angle at/above this centroid
     * cosine; below it they pool into the partition catch-all. Standalone
     * 1-phrase themes no longer exist. */
    attachFloor: 0.45,
    /** Nearest-to-centroid members stored as theme representatives. */
    representativeCount: 3,
    /** Themes labeled per LLM call. */
    labelBatchSize: 20,
    /** Hard cap on phrases loaded per cluster run. */
    maxPhrases: 5000,
    /** Per-partition clustering cap — the pairwise sim matrix is O(n²), so
     * one giant partition must not eat the 240s job budget; overflow phrases
     * pool into the partition catch-all with a warn log. */
    maxPartitionClusterPhrases: 1200,
    /** Post-label synonym-merge pass (embedding path only): one cheap-model
     * call per partition fusing angles the cosine threshold missed. */
    mergeRefinement: { enabled: true, maxThemesPerCall: 30 },
    /** Hook-worthy quotes returned to the Insights strip. */
    hookQuotesCap: 20,
    /** Recent candidate pool ranked down to hookQuotesCap. The strip shows the
     * best-scored quotes, not the most recent ones, so it must draw from a
     * window wider than the cap — otherwise "best of the 20 newest" is still
     * mostly filler. Bounded so the query URL and JS ranking stay cheap. */
    hookQuotesCandidatePool: 240,
  },
} as const;

/** Terms appended to brand/competitor names in Run B community searches. */
export const SUBREDDIT_INTENT_TERMS = [
  'review',
  'recommend',
  'worth it',
] as const;

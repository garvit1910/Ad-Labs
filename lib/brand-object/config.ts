/**
 * Layer 3 (Brand Object) — every tunable in one place (BRAND_PRESENCE_CONFIG
 * precedent). The design constraint behind most knobs is the $10/brand/month
 * hard cost ceiling: fingerprints + cooldowns gate every LLM call site, the
 * VOC promotion stage is zero-LLM by design, and the monthly call cap is the
 * hard stop when gating fails (a breach means a bug, and the meter converts
 * it into a visible non-retryable failure instead of silent spend).
 */
export const BRAND_OBJECT_CONFIG = {
  /** VOC fact promotion (brand_presence_themes/phrases → brand_facts). */
  promotion: {
    /** New embedded phrases past the watermark needed before the Layer-2
     * cluster-finalize hook enqueues a promote (small signal batches must
     * not trigger re-mining). A full build chain always promotes. */
    minNewPhrases: 25,
    /** Minimum hours between SAME-RUN incremental promotes per brand. A
     * changed cluster_run_id (rebuilt theme layer) bypasses this — promote
     * is zero-LLM, and interval-gating a genuine rebuild swallowed the
     * first-harvest refresh (Bee Inspired 2026-07-16). */
    minIntervalHours: 24,
    /** Half-life (days) for time-decayed frequency: each phrase contributes
     * 0.5^(ageDays/halfLife) to decayedFrequency, computed from its
     * mention's posted_at at promotion time. */
    decayHalfLifeDays: 90,
    /** A candidate matches an existing fact when centroid cosine >= this
     * (theme ids are unstable across cluster rebuilds; identity is carried
     * by embedding-space position + label slug fallback). Placeholder until
     * anchored against real pairwise distributions. */
    factMatchCosine: 0.75,
    /** Member phrase ids stored per VOC fact (evidence + next-run centroid
     * recomputation). Nearest-to-centroid first. */
    matchPhraseCap: 10,
    /** Verbatim quotes stored per VOC fact. */
    verbatimCap: 3,
    /** Hard cap on VOC facts kept per section per promotion pass — top-N by
     * compareVocRank (decayedFrequency desc). A real brand produced 112
     * uncapped VOC facts; a founder can review ~48. Ranked-out candidates
     * never claim a fact identity, so their previously-live candidate rows
     * retire on the next promote pass. */
    maxFactsPerVocSection: 12,
    /** Hard cap on member phrases loaded per promote run (cluster cap twin). */
    maxPhrases: 5000,
  },
  /** Website crawl (brand_object_crawl). */
  crawl: {
    cooldownDays: 7,
    /** Hard page cap per crawl run (home/about/product/FAQ style pages). */
    maxPages: 10,
    /** Pages with fewer text chars are dropped (nav shells, cookie walls). */
    minPageChars: 200,
    /** Per-page text cap sent to the identity model. */
    maxPageChars: 8000,
    /** Apify run wall-clock ceiling (ms). */
    runTimeoutMs: 15 * 60 * 1000,
    /**
     * Apify run memory (MB) for the `http` (cheerio, datacenter-proxy) crawl tier.
     * The `browser` tier keeps the actor default (8 GB) — it needs it.
     */
    httpTierMemoryMb: 1024,
    /**
     * When an `http`-tier crawl succeeds but yields ZERO pages passing
     * `minPageChars` (JS-rendered shell, bot wall), re-run once at the
     * `browser` tier (playwright + residential proxy). The browser tier is
     * ~10x the cost, so it is the escalation, never the default. An
     * `http`-tier run that FAILS/TIMES OUT always escalates regardless.
     */
    escalateToBrowserWhenEmpty: true,
  },
  /** Identity extraction (brand_object_identity). */
  identity: {
    cooldownDays: 7,
    /** Own ads sampled into the pack (creative copy columns). */
    maxOwnAds: 20,
  },
  /** Market distillation (brand_object_market). */
  market: {
    cooldownDays: 7,
    /** Minimum winner-gated ads before category priors are computed. */
    minWinnerAds: 5,
    /** Top label values kept per dimension in the prior aggregate. */
    topPerDimension: 5,
  },
  /** Persona synthesis (brand_object_personas). */
  personas: {
    cooldownHours: 24,
    /** Live VOC facts required before the call runs (else job = skipped). */
    minVocFacts: 5,
    /** Live identity facts required before the call runs. */
    minIdentityFacts: 1,
    min: 2,
    max: 4,
    /** A re-synthesized persona claims an existing persona fact's identity
     * when the cosine of their STATEMENT embeddings (name + description)
     * clears this. Anchored 2026-07-22 against two real Magic Spoon
     * generations (dev): every same-buyer rename scored 0.79 / 0.79 / 0.92
     * and the closest genuinely different pair 0.64, so 0.75 sits in the gap
     * (and matches promotion.factMatchCosine). Name-only embeddings do NOT
     * separate — one real rename scored 0.61 — which is why the description
     * rides in the identity text. */
    identityMatchCosine: 0.75,
  },
  /** Chunk embedding (brand_object_chunks). */
  chunks: {
    /** Chunks embedded per job run (one wave; FunctionTimeoutError resumes). */
    maxEmbedPerRun: 500,
  },
  /** Retrieval door. */
  retrieval: {
    defaultK: 8,
    maxK: 24,
    /** score = cosine * (confidenceFloor + confidenceWeight * confidence) —
     * confirmed facts win ties without burying fresh candidates. */
    confidenceFloor: 0.6,
    confidenceWeight: 0.4,
  },
  /** Report display surface (display-only — no scoring semantics). */
  insights: {
    /** Top-K VOC facts per section (by compareVocRank) rendered above the
     * fold in the VOC report; the rest sit behind "Show all N". */
    vocDisplayTopK: 5,
  },
  /** Status → ready gate (completeness.ts deriveStatus) — presence-based:
   * the report is meaningful once these facts EXIST. No founder confirmation
   * is required (the page is a report, not a review queue). */
  ready: {
    minOverallCompleteness: 0.7,
    minPositioningFacts: 1,
    minPersonaFacts: 1,
    minVocFacts: 3,
  },
} as const;

/** Monthly per-brand LLM call hard stop (env-overridable). A processor that
 * would exceed it throws NON-retryable (ingestion-budget posture). */
export function getBrandObjectMonthlyLlmCallCap(): number {
  const raw = Number(process.env.BRAND_OBJECT_MONTHLY_LLM_CALL_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60;
}

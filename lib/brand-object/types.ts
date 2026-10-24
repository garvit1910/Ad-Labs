/**
 * Layer 3 (Brand Object) — domain types. The Brand Object is the stable,
 * versioned, evidence-backed distillation of Layer 1 (competitor ads) +
 * Layer 2 (own-brand listening) + first-party data. Rows live in
 * brand_facts / brand_chunks / brand_object_state / brand_fact_suggestions
 * (drizzle/schema.ts). Sections and sources are OPEN strings at the DB and
 * validated against these lists in code (recommendations.type posture) so a
 * new section ships with no migration.
 */

export const BRAND_SECTIONS = [
  // Identity (from website crawl + profile + own ad copy)
  'positioning',
  'value_prop',
  'usp',
  'proof_point',
  'voice',
  'compliance',
  // VOC (promoted from brand_presence_themes/phrases)
  'voc_pain',
  'voc_desire',
  'voc_objection',
  'voc_praise',
  'competitor_intel',
  // Market (aggregated from ad_labels over winner-gated library ads)
  'market_prior',
  // Owned performance (derived from performance_memory by the creative loop).
  // Distinct from market_prior BY DESIGN: market_prior is a weak longevity
  // proxy over competitors' ads, performance_prior is realized spend and
  // revenue on our OWN ads. Never let a consumer confuse the two.
  'performance_prior',
  // Synthesis
  'persona',
] as const;
export type BrandSection = (typeof BRAND_SECTIONS)[number];

/** VOC sections map 1:1 onto brand_presence_themes.kind. */
export const VOC_SECTION_BY_THEME_KIND: Record<string, BrandSection> = {
  pain: 'voc_pain',
  desire: 'voc_desire',
  objection: 'voc_objection',
  praise: 'voc_praise',
};

export const FACT_STATUSES = ['candidate', 'confirmed', 'rejected'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const FACT_SOURCES = [
  'identity_extraction',
  'voc_promotion',
  'market_distillation',
  'persona_synthesis',
  'user_stated',
  // Derived from realized own-ad performance (performance_memory) by the
  // creative loop. Zero LLM: the numbers are computed, never narrated.
  'performance_derivation',
] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export const SUGGESTION_STATUSES = ['proposed', 'accepted', 'dismissed'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const BRAND_OBJECT_STATUSES = [
  'empty',
  'building',
  // legacy — no longer derived (report-only surface); old dev rows + the DB
  // CHECK still carry it, and the first recompute rewrites it.
  'in_review',
  'ready',
] as const;
export type BrandObjectStatus = (typeof BRAND_OBJECT_STATUSES)[number];

/** Schwartz awareness stages (persona cards + chunk retrieval filter). */
export const AWARENESS_STAGES = [
  'unaware',
  'problem_aware',
  'solution_aware',
  'product_aware',
  'most_aware',
] as const;
export type AwarenessStage = (typeof AWARENESS_STAGES)[number];

/**
 * Typed provenance ref stored in brand_facts.evidence (jsonb array). Any
 * `quote`/`sourceSentence` here was mechanically substring-verified against
 * its source text at write time — display surfaces render them verbatim.
 * EXCEPTION: `ad_label_agg` quotes are a winning ad's execution notes run
 * through `sanitizeExecutionNotes` (brand names scrubbed), so they are NOT
 * verbatim substrings of the label text — they currently have no display
 * consumer (the creative engine lifts them into strategy executionNotes).
 */
export interface EvidenceRef {
  type:
    | 'phrase'
    | 'mention'
    | 'crawl_page'
    | 'ad_label_agg'
    | 'own_ad'
    | 'theme_snapshot'
    // Another brand fact (personas cite the VOC facts their pains came from).
    | 'fact'
    // One performance_memory cell: the realized spend/impression/purchase sums
    // behind a derived lesson, plus the RULER those numbers were measured on.
    | 'perf_cell'
    // The founder (or an approved agent acting for one) stated the fact in
    // plain words — `review/state-fact.ts`. Carries who + when, never a quote.
    | 'user_stated';
  id?: string;
  url?: string;
  quote?: string;
  sourceSentence?: string;
  platform?: string;
  count?: number;
  /** `user_stated` receipts: the stating actor's id + ISO time. */
  actorId?: string;
  at?: string;
  /**
   * `perf_cell` receipts. A performance lesson without its basis and capture
   * ratio cannot be audited later, and cannot be compared against a lesson
   * measured on a different ruler.
   */
  perfCell?: {
    rollupSource: 'genome' | 'label';
    dimension: string;
    dimensionValue: string;
    basis: 'platform' | 'attributed';
    captureRatio: number | null;
    spend: number;
    impressions: number;
    adCount: number;
    windowStart: string | null;
    windowEnd: string | null;
    sourceMetric: string;
  };
}

/**
 * Deterministic numbers recomputed on each promotion/aggregation pass. The
 * LLM never sources any of these. Refreshing metrics on a HUMAN-CONFIRMED
 * fact is allowed (fresher counts are not a content overwrite); statement/
 * details/confidence on confirmed facts only change via the founder.
 */
export interface FactMetrics {
  frequency?: number;
  decayedFrequency?: number;
  perPlatform?: Record<string, number>;
  avgSentiment?: number | null;
  lastSeenAt?: string | null;
  winnerCount?: number;
  replicationWeight?: number;
  /** market_prior only: ISO max(tracked_competitors.last_synced_at) over the
   * competitors backing this dimension's winners. Lives in `metrics` (not
   * `details`) deliberately — metrics refresh on every reconcile touch and sit
   * outside the brand-context row content hash, so the timestamp self-updates
   * without re-minting rows or moving pack fingerprints. See
   * lib/brand-object/freshness.ts. */
  evidenceAsOf?: string;
}

/** A live brand_facts row as the reconciler sees it (valid_to IS NULL). */
export interface LiveFact {
  id: string;
  section: BrandSection;
  factKey: string;
  statement: string;
  details: Record<string, unknown>;
  confidence: number;
  source: FactSource;
  status: FactStatus;
  evidence: EvidenceRef[];
  metrics: FactMetrics;
  validFrom: string;
}

/**
 * What a distillation stage proposes before reconciliation. `factKey` is
 * assigned by fact-key matching (assignFactKeys) before the reconciler runs.
 * `centroid` is matching-only state (mean phrase embedding for VOC facts) —
 * never persisted on the fact row.
 */
export interface CandidateFact {
  section: BrandSection;
  factKey: string;
  statement: string;
  details: Record<string, unknown>;
  confidence: number;
  source: FactSource;
  evidence: EvidenceRef[];
  metrics: FactMetrics;
  centroid?: number[];
}

/** Reconciler output — the persistence layer executes these in order:
 * stamp valid_to FIRST, then insert (the partial unique live-identity index
 * allows at most one live row per key; a crash between the two steps leaves
 * no live row, which the next run re-inserts). */
export interface ReconcilePlan {
  inserts: CandidateFact[];
  supersedes: Array<{ liveFactId: string; candidate: CandidateFact }>;
  suggestions: Array<{
    liveFactId: string;
    candidate: CandidateFact;
    reason: string;
  }>;
  /** Content identical — update metrics/evidence in place, no new version. */
  metricRefreshes: Array<{ liveFactId: string; candidate: CandidateFact }>;
  /** Suppressed candidates (kept live fact, or rejected identity). */
  noops: Array<{ factKey: string; reason: 'kept_live' | 'rejected_identity' }>;
}

/** Per-section-group completeness (0..1) + overall. Persisted on
 * brand_object_state.completeness. */
export interface Completeness {
  overall: number;
  perSection: Record<string, number>;
}

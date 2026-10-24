/**
 * Adcero reuse export — standalone data contracts (no imports).
 *
 * Source commit: f9bb088c93f40f1c2ae41886ba4a21b7556e102f
 * Every type below is copied from (or is a documented projection of) the Adcero
 * source file named in its comment, so the new project can type its pipeline
 * outputs and page payloads without importing Adcero. Enum arrays are verbatim.
 *
 * Single-brand note: Adcero rows carry `organization_id` (multi-tenant). The
 * `*Row` types here drop it; keep a constant org id in your DB if you copy the
 * processors unchanged (see REUSE_MANIFEST.md, Area 8).
 */

/* ════════════════════════════════════════════════════════════════════════
 * 1. Closed enums — services/ad-library/label-taxonomy.ts (taxonomy v3)
 * ════════════════════════════════════════════════════════════════════════ */

export const LABEL_TAXONOMY_VERSION = 3;

export const HOOK_ARCHETYPES = [
  'problem_callout',
  'bold_claim',
  'question',
  'social_proof',
  'curiosity',
  'offer_led',
  'demo',
  'testimonial',
  'comparison',
  'story_narrative',
  'statistic',
  'pov_relatable',
  'other',
] as const;

/** Universal angle list = the values of `ad_labels.angle_universal`. */
export const ANGLES = [
  'pain_relief',
  'convenience',
  'price_value',
  'status',
  'health',
  'time_saving',
  'trust_safety',
  'other',
] as const;

export const FORMATS = [
  'ugc',
  'studio',
  'text_overlay_static',
  'meme',
  'founder_talking',
  'product_demo',
  'before_after',
  'carousel_listicle',
  'testimonial_review',
  'social_screenshot',
  'us_vs_them',
  'press_advertorial',
  'tutorial_howto',
  'unboxing',
  'lifestyle_static',
  'product_only_static',
  'carousel_product_set',
  'other',
] as const;

/** `'none'` is never persisted: the labeller stores NULL instead. */
export const OFFER_TYPES = [
  'discount',
  'free_shipping',
  'bundle',
  'trial',
  'guarantee',
  'bogo_gwp',
  'urgency_limited',
  'financing',
  'giveaway',
  'subscribe_save',
  'none',
] as const;

/** Universal persona list = the values of `ad_labels.persona_universal`. */
export const PERSONAS = [
  'parents_family',
  'young_adults',
  'professionals',
  'midlife_adults',
  'seniors',
  'general_broad',
  'other',
] as const;

export const FUNNEL_STAGES = ['tof_problem', 'mof_solution', 'bof_offer', 'other'] as const;

export const TONES = [
  'humorous',
  'aspirational',
  'educational',
  'fear_urgency',
  'heartfelt',
  'plain_promotional',
  'other',
] as const;

export const DURATION_BUCKETS = ['lt15', '15_30', '30_60', 'gt60'] as const;

export const VISUAL_STYLES = [
  'lo_fi_ugc',
  'polished_studio',
  'designed_graphic',
  'screen_capture',
  'cinematic',
  'meme_style',
  'other',
] as const;

export const ASPECT_RATIOS = ['9:16', '4:5', '1:1', '16:9', 'other'] as const;

export const SETTINGS = ['home', 'studio', 'outdoor', 'digital', 'other'] as const;

export const PACINGS = ['static', 'slow', 'fast'] as const;

export type HookArchetype = (typeof HOOK_ARCHETYPES)[number];
export type Angle = (typeof ANGLES)[number];
export type AdFormat = (typeof FORMATS)[number];
export type OfferType = (typeof OFFER_TYPES)[number];
export type Persona = (typeof PERSONAS)[number];
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export type Tone = (typeof TONES)[number];
export type DurationBucket = (typeof DURATION_BUCKETS)[number];
export type VisualStyle = (typeof VISUAL_STYLES)[number];
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type FingerprintSetting = (typeof SETTINGS)[number];
export type Pacing = (typeof PACINGS)[number];

/** `ad_labels.fingerprint` jsonb (label-taxonomy.ts `AdFingerprint`). */
export interface AdFingerprint {
  people_present?: boolean;
  talking_head?: boolean;
  text_overlay?: boolean;
  setting?: FingerprintSetting;
  voiceover?: boolean;
  pacing?: Pacing;
  spoken_hook?: string;
  duration_bucket?: DurationBucket;
  visual_hook?: string;
  captions?: boolean;
  music?: boolean;
  tone?: Tone;
  execution_notes?: string;
}

/**
 * `ad_labels.angle` / `ad_labels.persona` hold an INDUSTRY-specific token
 * (lib/brand-identity/industry-vocabulary.ts INDUSTRY_ANGLES / INDUSTRY_PERSONAS,
 * each list + ['price_value','trust_safety','other'] for angles and
 * ['general_broad','other'] for personas), or a universal token when the
 * competitor's industry is unclassified. Hence plain `string` here.
 */
export type IndustryAngleToken = string;
export type IndustryPersonaToken = string;

/** lib/brand-identity/industries.ts — the 16 industry keys. */
export const INDUSTRY_KEYS = [
  'accessories',
  'automotive',
  'beauty',
  'jewelry',
  'shoes',
  'clothing',
  'electronics',
  'sport',
  'food',
  'gaming',
  'health',
  'home',
  'pets',
  'software',
  'books',
  'services',
] as const;
export type IndustryKey = (typeof INDUSTRY_KEYS)[number];

/* ════════════════════════════════════════════════════════════════════════
 * 2. Normalized customer-voice signal — lib/brand-presence/types.ts
 *    (there is NO `brand_signals` table; the row is `brand_mentions`)
 * ════════════════════════════════════════════════════════════════════════ */

export const MENTION_PLATFORMS = [
  'reddit',
  'amazon',
  'google_maps',
  'x',
  'trustpilot',
  'tiktok',
  'instagram',
] as const;
export const MENTION_DATA_TYPES = ['post', 'comment', 'review'] as const;
export const MENTION_SCOPES = ['brand', 'competitor', 'category'] as const;
export const MENTION_RELEVANCES = ['pending', 'relevant', 'irrelevant', 'not_required'] as const;
export const EXTRACTION_STATUSES = ['pending', 'done', 'skipped', 'error'] as const;
export const MENTION_ANGLES = ['pain_point', 'praise', 'wish', 'question', 'comparison', 'other'] as const;
export const MENTION_SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'] as const;
export const THEME_KINDS = ['pain', 'desire', 'objection', 'praise'] as const;
export const PHRASE_KINDS = ['pain', 'desire', 'objection', 'praise', 'quote'] as const;

export type MentionPlatform = (typeof MENTION_PLATFORMS)[number];
export type MentionDataType = (typeof MENTION_DATA_TYPES)[number];
export type MentionScope = (typeof MENTION_SCOPES)[number];
export type MentionRelevance = (typeof MENTION_RELEVANCES)[number];
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];
export type MentionAngle = (typeof MENTION_ANGLES)[number];
export type MentionSentiment = (typeof MENTION_SENTIMENTS)[number];
export type ThemeKind = (typeof THEME_KINDS)[number];
export type PhraseKind = (typeof PHRASE_KINDS)[number];

/** `brand_mentions.tags.insight` (written by the extract step). */
export interface MentionInsight {
  competitors: string[];
  angle: MentionAngle;
  sentiment: MentionSentiment;
  gist: string;
  usable?: boolean;
  model: string;
  extractedAt: string;
}

export interface ExtractedPhraseEntry {
  phrase: string;
  paraphrase: string;
}

/** `brand_mentions.extraction` jsonb. */
export interface MentionExtraction {
  sentiment: number;
  pains: ExtractedPhraseEntry[];
  desires: ExtractedPhraseEntry[];
  objections: ExtractedPhraseEntry[];
  praise: ExtractedPhraseEntry[];
  /** Exact substrings of title+body (validated at write time). */
  quotes: string[];
  model: string;
  extractedAt: string;
}

/**
 * THE normalized signal row = Adcero `BrandMention` minus `organization_id`.
 * Upsert key: (brand_profile_id, platform, external_id). Never deleted.
 * `author_ref` is a sha256 of the username — raw identities are never stored.
 */
export interface NormalizedSignalRow {
  id: string;
  brand_profile_id: string;
  source_id: string | null;
  platform: MentionPlatform | (string & {});
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
  rating: number | null;
  extraction_status: ExtractionStatus;
  /** Raw-page archive key (Adcero: R2 object key). */
  raw_ref: string | null;
  parent_external_id: string | null;
  parent_title: string | null;
  created_at: string;
  /** Per-platform metadata lives under tags.{amazon,google,x,trustpilot,tiktok,instagram}. */
  tags?: { insight?: MentionInsight; gateSweeps?: number; [key: string]: unknown };
  extraction?: MentionExtraction | null;
}

/* Per-source normalizer outputs (verbatim from services/brand-presence/*-normalizer.ts).
 * Each normalizer returns `{ kind: 'mention' | 'review' | ..., ... } | { kind: 'skipped', reason }`;
 * the processor maps the payload below onto a NormalizedSignalRow. */

export interface NormalizedRedditMention {
  external_id: string;
  data_type: MentionDataType;
  url: string | null;
  subreddit: string | null;
  author_ref: string | null;
  title: string | null;
  body: string | null;
  posted_at: string | null;
  parent_external_id: string | null;
  parent_title: string | null;
}

export interface NormalizedGoogleReview {
  external_id: string;
  body: string | null;
  rating: number | null;
  posted_at: string | null;
  url: string | null;
  author_ref: string | null;
  likes: number | null;
  owner_response_text: string | null;
  owner_response_at: string | null;
  original_text: string | null;
  review_image_count: number | null;
  place_id: string | null;
}

export interface NormalizedXMention {
  external_id: string;
  data_type: MentionDataType;
  url: string | null;
  author_ref: string | null;
  body: string;
  posted_at: string;
  parent_external_id: string | null;
  tier: 'handle' | 'variant';
  matched_term: string | null;
  engagement: {
    likes: number | null;
    retweets: number | null;
    replies: number | null;
    quotes: number | null;
    views: number | null;
    authorFollowers: number | null;
    lang: string | null;
  };
  short_text: boolean;
}

export interface NormalizedTrustpilotReview {
  external_id: string;
  title: string | null;
  body: string | null;
  rating: number | null;
  posted_at: string | null;
  url: string | null;
  author_ref: string | null;
  verified: boolean;
  country: string | null;
  company_reply_text: string | null;
  company_reply_at: string | null;
  likes: number | null;
}

export interface NormalizedTikTokVideo {
  video_id: string;
  url: string;
  caption: string | null;
  posted_at: string | null;
  comment_count: number;
}

export interface NormalizedTikTokComment {
  external_id: string;
  url: string | null;
  author_ref: string | null;
  body: string;
  posted_at: string | null;
  video_id: string;
  video_url: string | null;
  parent_title: string | null;
  likes: number | null;
  reply_count: number | null;
  is_reply: boolean;
  parent_comment_id: string | null;
  short_text: boolean;
}

export interface NormalizedInstagramPost {
  post_id: string;
  kind: 'post' | 'reel';
  url: string;
  caption: string | null;
  posted_at: string | null;
  comment_count: number;
}

export interface NormalizedInstagramComment {
  external_id: string;
  url: string | null;
  author_ref: string | null;
  body: string;
  posted_at: string | null;
  post_id: string;
  post_url: string | null;
  post_kind: 'post' | 'reel';
  parent_title: string | null;
  likes: number | null;
  reply_count: number | null;
  short_text: boolean;
}

/** services/ad-library/types.ts — normalized competitor ad (Meta + Google actors). */
export type AdLibraryMediaType = 'image' | 'video' | 'carousel' | 'text' | 'unknown';
export interface AdSpendRange {
  lowerBound: number;
  upperBound: number | null;
}
export interface NormalizedAd {
  externalAdId: string;
  pageId?: string | null;
  adSnapshotUrl: string | null;
  creativeBodies: string[];
  creativeLinkTitles: string[];
  pageName: string | null;
  publisherPlatforms: string[];
  /** ISO timestamp. */
  deliveryStart: string;
  /** ISO timestamp, null while the ad is still delivering. */
  deliveryStop: string | null;
  euTotalReach: number | null;
  currency: string | null;
  spendRange: AdSpendRange | null;
  mediaType: AdLibraryMediaType;
  mediaUrls: string[] | null;
  videoUrls?: string[] | null;
  numServedDays?: number | null;
  landingUrl?: string | null;
  landingDomain?: string | null;
}

/* ════════════════════════════════════════════════════════════════════════
 * 3. Brand context (Layer 3) — lib/brand-object/types.ts + retrieval/service.ts
 * ════════════════════════════════════════════════════════════════════════ */

export const BRAND_SECTIONS = [
  'positioning',
  'value_prop',
  'usp',
  'proof_point',
  'voice',
  'compliance',
  'voc_pain',
  'voc_desire',
  'voc_objection',
  'voc_praise',
  'competitor_intel',
  'market_prior',
  'performance_prior',
  'persona',
] as const;
export const FACT_STATUSES = ['candidate', 'confirmed', 'rejected'] as const;
export const FACT_SOURCES = [
  'identity_extraction',
  'voc_promotion',
  'market_distillation',
  'persona_synthesis',
  'user_stated',
  'performance_derivation',
] as const;
export const BRAND_OBJECT_STATUSES = ['empty', 'building', 'in_review', 'ready'] as const;
export const AWARENESS_STAGES = [
  'unaware',
  'problem_aware',
  'solution_aware',
  'product_aware',
  'most_aware',
] as const;

export type BrandSection = (typeof BRAND_SECTIONS)[number];
export type FactStatus = (typeof FACT_STATUSES)[number];
export type FactSource = (typeof FACT_SOURCES)[number];
export type BrandObjectStatus = (typeof BRAND_OBJECT_STATUSES)[number];
export type AwarenessStage = (typeof AWARENESS_STAGES)[number];

export interface EvidenceRef {
  type:
    | 'phrase'
    | 'mention'
    | 'crawl_page'
    | 'ad_label_agg'
    | 'own_ad'
    | 'theme_snapshot'
    | 'fact'
    | 'perf_cell'
    | 'user_stated';
  id?: string;
  url?: string;
  quote?: string;
  sourceSentence?: string;
  platform?: string;
  count?: number;
  actorId?: string;
  at?: string;
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

export interface FactMetrics {
  frequency?: number;
  decayedFrequency?: number;
  perPlatform?: Record<string, number>;
  avgSentiment?: number | null;
  lastSeenAt?: string | null;
  winnerCount?: number;
  replicationWeight?: number;
  evidenceAsOf?: string;
}

/** Section-shaped `details` written by each distillation step. */
export interface VocFactDetails {
  label: string;
  summary: string | null;
  themeKind: ThemeKind;
  matchPhraseIds: string[];
}
export interface MarketPriorDetails {
  /** angle | hook_archetype | format | offer_type (+ execution dims: style, setting, tone, people_present, …). */
  dimension: string;
  value: string;
  share: number;
  conceptCount: number;
  totalConcepts: number;
}
export interface VoiceDetails {
  traits: string[];
  toneDo: string[];
  toneDont: string[];
}
export interface PersonaFactRef {
  fact_id: string;
  note: string;
}
export interface PersonaDetails {
  name: string;
  description: string;
  awarenessStage: AwarenessStage;
  extrapolated: boolean;
  pains: PersonaFactRef[];
  desires: PersonaFactRef[];
  objections: PersonaFactRef[];
  /** Exact substrings of real mentions. */
  verbatims: string[];
}

/**
 * One live brand fact as the API returns it (`hooks/brand-object/useBrandObject.ts`
 * `BrandFactView`). DB table `brand_facts` is append-only: a row is live while
 * `valid_to IS NULL`; supersede stamps the old row's valid_to then inserts a new
 * row with `previous_version_id`. Machine confidence < 1.0 (1.0 = founder-stated).
 */
export interface BrandFact {
  id: string;
  section: BrandSection;
  fact_key: string;
  statement: string;
  details: Record<string, unknown>;
  confidence: number;
  source: FactSource | (string & {});
  status: 'candidate' | 'confirmed';
  evidence: EvidenceRef[];
  metrics: FactMetrics;
  valid_from: string;
}

/** Full `brand_facts` row (minus organization_id), for a pipeline that writes them. */
export interface BrandFactRow extends Omit<BrandFact, 'status'> {
  brand_profile_id: string;
  status: FactStatus;
  valid_to: string | null;
  previous_version_id: string | null;
  created_at: string;
  updated_at: string;
}

/** `brand_chunks` row (minus organization_id). One chunk per live fact. */
export interface BrandChunk {
  id: string;
  brand_profile_id: string;
  fact_id: string;
  /** `[section] statement` + best quote + a metrics line (lib/brand-object/chunks.ts). */
  content: string;
  section: BrandSection;
  /** Persona fact_key slug; null = not persona-scoped. */
  persona_key: string | null;
  /** null = not stage-scoped. */
  awareness_stage: AwarenessStage | null;
  source_type: FactSource | (string & {});
  metadata: Record<string, unknown>;
  /** pgvector text literal "[a,b,…]" — text-embedding-3-small, 1536 dims. */
  embedding: string | null;
  embedding_model: string | null;
  content_hash: string;
  created_at: string;
}

/** lib/brand-object/retrieval/service.ts — the one sanctioned retrieval door. */
export interface BrandSliceRequest {
  organizationId: string;
  brandProfileId: string;
  /** Omitted = all non-compliance sections. */
  sections?: BrandSection[];
  personaKey?: string;
  awarenessStage?: AwarenessStage;
  /** Required — the door never dumps the whole object. */
  query: string;
  /** Default 8, max 24. */
  k?: number;
}
export interface RetrievedFact {
  factId: string;
  factKey: string;
  section: BrandSection;
  statement: string;
  details: Record<string, unknown>;
  bestVerbatim?: string;
  confidence: number;
  status: Exclude<FactStatus, 'rejected'>;
  metrics: FactMetrics;
  evidence: EvidenceRef[];
  /** cosine × (0.6 + 0.4 × confidence); compliance facts score 1. */
  score: number;
}
export interface BrandSlice {
  facts: RetrievedFact[];
  /** Always appended, deduped against facts, never counted against k. */
  complianceFacts: RetrievedFact[];
  provenanceFactIds: string[];
  meta: { retrievedAt: string };
}
/** `retrieveBrandSlice(db: SupabaseClient, req: BrandSliceRequest): Promise<BrandSlice>` */
export type RetrieveBrandSlice = (req: BrandSliceRequest) => Promise<BrandSlice>;

export interface Completeness {
  overall: number;
  perSection: Record<string, number>;
}

/** The whole brand context handed to downstream agents (export shape, not an Adcero table). */
export interface BrandContext {
  brandProfileId: string;
  brandName: string;
  websiteUrl: string;
  facts: BrandFact[];
  chunks: BrandChunk[];
  completeness: Completeness | null;
  status: BrandObjectStatus;
}

/* ════════════════════════════════════════════════════════════════════════
 * 4. Competitor ad with labels + cluster + winner flag
 *    lib/brand-identity/types.ts (EnrichedAd = library_ads_enriched view row)
 * ════════════════════════════════════════════════════════════════════════ */

export interface EnrichedAd {
  id: string;
  organization_id: string;
  competitor_id: string;
  external_ad_id: string;
  platform: string;
  ad_snapshot_url: string | null;
  creative_bodies: string[] | null;
  creative_link_titles: string[] | null;
  page_name: string | null;
  publisher_platforms: string[] | null;
  delivery_start: string;
  delivery_stop: string | null;
  eu_total_reach: number | null;
  currency: string | null;
  spend_range: { lowerBound: number; upperBound: number | null } | null;
  media_type: string | null;
  media_urls: string[] | null;
  video_urls: string[] | null;
  hosted_media_urls: (string | null)[] | null;
  hosted_video_urls: (string | null)[] | null;
  num_served_days: number | null;
  landing_url: string | null;
  landing_domain: string | null;
  raw_ref: string | null;
  /** Ingestion time — NOT launch date. Use delivery_start for "launched/new". */
  first_seen_at: string;
  last_seen_at: string;
  hook_archetype: HookArchetype | null;
  /**
   * Industry-specific angle token (e.g. 'health_nutrition' for food) or a
   * universal one when the competitor's industry is unclassified. NOTE: Adcero's
   * own `EnrichedAd.angle` is typed `Angle | null` (the 8 universal values), which
   * is narrower than what the view returns at runtime; this contract types the
   * runtime truth. See REUSE_MANIFEST.md "Adcero defects found".
   */
  angle: IndustryAngleToken | null;
  /** Universal angle (ANGLES) mapped from `angle`; present on the view and in API payloads. */
  angle_universal: Angle | null;
  persona: string | null;
  persona_universal: Persona | null;
  funnel_stage: FunnelStage | null;
  format: AdFormat | null;
  style: VisualStyle | null;
  aspect_ratio: AspectRatio | null;
  fingerprint: AdFingerprint | null;
  offer_type: OfferType | null;
  hook_text: string | null;
  summary: string | null;
  confidence: number | null;
  label_model: string | null;
  labeled_at: string | null;
  /** View-derived: (delivery_stop ?? (last_seen within 32d ? now : last_seen)) − delivery_start, days. */
  longevity_days: number;
  /** View-derived: delivery_stop IS NULL AND last_seen_at > now() − 32 days. */
  is_active: boolean;
}

/**
 * Export projection for downstream agents: an EnrichedAd plus the read-time
 * cluster assignment (lib/brand-identity/clustering.ts, never persisted) and the
 * winner gate (lib/brand-identity/win-profile.ts + win-score.ts).
 */
export interface CompetitorAd extends EnrichedAd {
  /** Smallest ad id in the UPGMA message family (cosine ≥ 0.75); null = no embedding. */
  clusterId: string | null;
  /** Family size — what "replication" means everywhere (buildClusterSizeIndex). */
  replicationCount: number;
  /** Distinct near-duplicate buckets (union-find ≥ 0.95) inside the family. */
  distinctVariations: number | null;
  /** 0–100, absolute curves (win-score-constants.ts). */
  winScore: number;
  /** buildWinnerEvaluator: floor (Meta 30d / Google 14d) AND top-quartile (P75) of competitor×surface cohort (≥10 ads, else floor-only). */
  isWinner: boolean;
  winProfile: 'meta' | 'google:visual' | 'google:text' | 'neutral';
}

/* ════════════════════════════════════════════════════════════════════════
 * 5. Competitor Analysis page — props/data (lib/brand-identity/types.ts,
 *    lib/brand-identity/dashboard.ts, hooks/brand-identity/*)
 * ════════════════════════════════════════════════════════════════════════ */

export type DashboardPlatform = 'meta' | 'google' | 'all';

export interface TrackedCompetitor {
  id: string;
  organization_id: string;
  brand_profile_id: string | null;
  name: string;
  platform: 'meta' | 'google';
  keyword: string | null;
  country: string;
  page_ref: string | null;
  meta_page_id: string | null;
  meta_page_name: string | null;
  google_advertiser_id: string | null;
  google_advertiser_name: string | null;
  status: 'active' | 'paused';
  industry: string | null;
  last_synced_at: string | null;
  created_at: string;
  adCount: number;
  labeledCount: number;
  activeCount: number;
  winnerCount: number;
  syncing: boolean;
  syncFailed: boolean;
}

export type OverIndexDimension =
  | 'format'
  | 'hook_archetype'
  | 'offer_type'
  | 'angle'
  | 'angle_universal'
  | 'persona'
  | 'funnel_stage';
export type MediaQuadrantDimension =
  | 'style'
  | 'aspect_ratio'
  | 'tone'
  | 'setting'
  | 'pacing'
  | 'duration_bucket';
export type AnalysisDimension = OverIndexDimension | MediaQuadrantDimension;

export interface DimensionBreakdownRow {
  label: string;
  totalCount: number;
  winnerCount: number;
  winRate: number;
  medianLongevity: number;
  avgReach: number | null;
  activeShare: number;
  medianWinScore: number;
}

export interface OverIndexRow {
  label: string;
  winnerShare: number;
  allShare: number;
  lift: number;
  winnerCount: number;
  totalCount: number;
  medianLongevity: number;
  activeShare: number;
  avgReach: number | null;
  topAdId: string | null;
  exampleAdIds: string[];
  medianWinScore: number;
}

export interface DimensionOverIndex {
  dimension: AnalysisDimension;
  rows: OverIndexRow[];
  medianWinScore: number;
}

export interface MediaQuadrantGroup {
  totalAds: number;
  visuallyLabeledAds: number;
  overIndex: DimensionOverIndex[];
}

export interface MediaQuadrants {
  image: MediaQuadrantGroup;
  video: MediaQuadrantGroup;
}

export interface WinningAd {
  ad: EnrichedAd;
  winScore: number;
  replicationCount: number;
  reachAvailable: boolean;
}

export interface AngleClusterMember {
  ad: EnrichedAd;
  winScore: number;
}

export interface AngleCluster {
  clusterId: string;
  label: string;
  labelIsPlaceholder?: true;
  replicationCount: number;
  winnerCount: number;
  winRate: number;
  medianLongevity: number;
  avgReach: number | null;
  topWinScore: number;
  competitorId: string;
  competitorName: string;
  members: AngleClusterMember[];
}

/** POST /api/brand-identity/dashboard → { data: BrandIdentityDashboard } */
export interface BrandIdentityDashboard {
  scope: {
    competitorId: string | null;
    totalAds: number;
    labeledAds: number;
    activeAds: number;
    provenWinners: number;
    embeddedAds: number;
  };
  winners: WinningAd[];
  overIndex: DimensionOverIndex[];
  breakdowns: Record<OverIndexDimension, DimensionBreakdownRow[]>;
  mediaQuadrants: MediaQuadrants;
  angleClusters: AngleCluster[];
  exampleAds: EnrichedAd[];
}

/** computeScopedStats(competitors, { competitorId?, platform }) — client-side sum. */
export interface ScopedStats {
  competitorsTracked: number;
  totalAds: number;
  labeledAds: number;
  activeAds: number;
  provenWinners: number;
}

/** Component props (inline in Adcero; named here). */
export interface SignalOverviewProps {
  stats: ScopedStats;
  labeledPct: number;
  competitors: TrackedCompetitor[];
  competitorId: string | undefined;
  platform: DashboardPlatform;
  isLoading: boolean;
  hasNoCompetitors: boolean;
}
export interface SignalDashboardProps {
  competitorId: string | undefined;
  platform: DashboardPlatform;
}
export interface WinnersVsRestPanelProps {
  overIndex: DimensionOverIndex[];
  labeledAds: number;
  totalAds: number;
  mediaQuadrants: MediaQuadrants;
  colorScheme?: 'category' | 'signal';
}
export interface DimensionPerformancePanelProps {
  breakdowns: Record<OverIndexDimension, DimensionBreakdownRow[]>;
  mediaQuadrants: MediaQuadrants;
  surface?: 'card' | 'flat';
}
export interface AdDetailSheetProps {
  ad: EnrichedAd | null;
  ads?: EnrichedAd[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Everything the Competitor Analysis page fetches, keyed by the endpoint the
 * hooks call (all POST JSON, response wrapped as `{ data: … }`).
 * fixtures/competitor-analysis.json has this shape.
 */
export interface CompetitorAnalysisPagePayload {
  'brand-identity/competitors/list': TrackedCompetitor[];
  'brand-identity/dashboard': BrandIdentityDashboard;
  'brand-identity/labels/summaries': { locale: string; summaries: Record<string, string> };
  'brand-identity/collections/list': unknown[];
  'brand-identity/collections/membership': Record<string, string[]>;
}

/* ════════════════════════════════════════════════════════════════════════
 * 6. Brand Identity page — props/data (hooks/brand-object/useBrandObject.ts,
 *    lib/brand-object/synthesis/types.ts, lib/brand-presence/client-schemas.ts)
 * ════════════════════════════════════════════════════════════════════════ */

export interface BrandPresenceProfile {
  id: string;
  organization_id: string;
  website_url: string;
  brand_name: string;
  name_variants: string[];
  product_description: string | null;
  category: string | null;
  competitors: string[];
  status: 'draft' | 'confirmed';
  presence_role: 'self' | 'competitor' | null;
  amazon_marketplace: string;
  amazon_storefront_url: string | null;
  amazon_product_urls: string[];
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BrandBuildProgress {
  competitors: { tagged: number; synced: number; syncing: number };
  listening: { keptMentions: number; activeJobs: number; activeSources: number };
}

export interface BrandObjectStatusView {
  state: {
    status: BrandObjectStatus;
    completeness: Completeness | Record<string, never>;
    cost: Record<string, { llmCalls?: number }>;
  } | null;
  activeJobs: Array<{ type: string; status: string }>;
  progress?: BrandBuildProgress;
}

export interface BrandSynthesisFinding {
  point: string;
  evidence: string;
}
export interface BrandSynthesis {
  id: string;
  organizationId: string;
  brandProfileId: string;
  status: 'ready' | 'skipped' | 'failed';
  trigger: string;
  headline: string | null;
  story: string[];
  strengths: BrandSynthesisFinding[];
  tensions: BrandSynthesisFinding[];
  watchItems: Array<{ observation: string; suggestedCheck: string }>;
  hypotheses: Array<{ hypothesis: string; groundedIn: string }>;
  inputsFingerprint: string | null;
  factsCount: number;
  model: string | null;
  cost: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    usd: number | null;
    model: string;
  } | null;
  inputSnapshot: {
    factsCount: number;
    perSectionCounts: Record<string, number>;
    completenessOverall: number | null;
    brandName: string | null;
    locale?: string;
  } | null;
  generatedBy: string | null;
  generatedByType: string | null;
  error: { code: string; reason: string } | null;
  createdAt: string;
  updatedAt: string;
}
export interface BrandSynthesisView {
  synthesis: BrandSynthesis | null;
  staleness: { stale: boolean; reason: 'no_synthesis' | 'facts_changed' | 'fresh' };
  translated?: boolean;
}

export interface BrandPresenceSourceStatus {
  id: string;
  source_type: string;
  uri: string;
  label: string | null;
  status: string;
  last_synced_at: string | null;
  awaitingConfirm?: boolean;
}
export interface BrandPresenceCounts {
  total: number;
  kept: number;
  brand: number;
  brandKept: number;
  competitor: number;
  competitorKept: number;
  category: number;
  categoryKept: number;
  relevant: number;
  irrelevant: number;
  pending: number;
  topSubreddits: Array<{ subreddit: string; count: number }>;
}
export interface BrandPresenceStatus {
  profileStatus: string | null;
  sources: BrandPresenceSourceStatus[];
  counts: BrandPresenceCounts | null;
  activeJobs: Array<{ id: string; type: string; status: string }>;
}

export interface BrandPresenceSource {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_type: string;
  uri: string;
  label: string | null;
  status: 'available' | 'coming_soon' | 'pending' | 'running' | 'synced' | 'error';
  meta: Record<string, unknown>;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LandscapeTheme {
  kind: ThemeKind;
  label: string;
  summary: string | null;
  frequency: number;
  mentionCount: number;
  avgSentiment: number | null;
}
export interface LandscapeQuote {
  body: string;
  platform: string;
  url: string | null;
  rating: number | null;
  postedAt: string | null;
  sentiment: number;
}
export interface ProfileVoice {
  profileId: string;
  brandName: string;
  role: 'self' | 'competitor' | null;
  keptMentions: number;
  platforms: Array<{ platform: string; kept: number }>;
  sentiment: {
    score: number | null;
    positivePct: number;
    neutralPct: number;
    negativePct: number;
    scoredWeight: number;
  } | null;
  themesByKind: Record<ThemeKind, LandscapeTheme[]>;
  topPraise: LandscapeQuote | null;
  topComplaint: LandscapeQuote | null;
  hookQuotes: string[];
  lastSyncedAt: string | null;
}
export interface CompetitiveLandscapeResponse {
  self: ProfileVoice;
  competitors: ProfileVoice[];
  contrasts: Array<{
    competitorId: string;
    kind: 'ahead' | 'behind' | 'level' | 'unmeasured';
    headline: string;
    caption: string;
  }>;
  generatedAt: string;
}

export interface OwnAdAngleMix {
  totalLabeledAds: number;
  byAngle: Record<string, number>;
  byUniversal: Record<string, number>;
}

export type ReportTreatment = 'classic' | 'distilled';

/** components/brand-object/insights/BrandInsightsDashboard.tsx */
export interface BrandInsightsDashboardProps {
  facts: BrandFact[];
  factsLoading: boolean;
  factsError: boolean;
  objectStatus: BrandObjectStatusView | null;
  brandName?: string | null;
  websiteUrl?: string | null;
  treatment?: ReportTreatment;
}

/**
 * Everything the Brand Identity page fetches, keyed by endpoint (POST JSON
 * `{ data: … }` except the synthesis GET). fixtures/brand-identity.json has
 * this shape. `brand-object/own-performance` is omitted on purpose: answer it
 * 404 and the chapter hides (the new project has no ad accounts).
 */
export interface BrandIdentityPagePayload {
  'brand-presence/profiles/list': {
    profiles: BrandPresenceProfile[];
    keptCounts: Record<string, number>;
  };
  'brand-object/portfolio': { orgCompetitorCount: number; profiles: unknown[] };
  'brand-object/status': BrandObjectStatusView;
  'brand-object/facts': {
    facts: BrandFact[];
    pendingSuggestionsByFactId: Record<string, number>;
  };
  /** GET /api/organizations/{orgId}/brand-identity/synthesis?brandProfileId=… */
  'brand-identity/synthesis': BrandSynthesisView;
  'brand-object/own-ad-angles': { mix: OwnAdAngleMix };
  'brand-presence/sources/list': {
    sources: BrandPresenceSource[];
    mentionCounts: Record<string, number>;
  };
  'brand-presence/status': BrandPresenceStatus;
  'brand-presence/insights/competitive-landscape': CompetitiveLandscapeResponse;
  'brand-identity/competitors/list': TrackedCompetitor[];
}

import type {
  AdFingerprint,
  AdFormat,
  Angle,
  AspectRatio,
  FunnelStage,
  HookArchetype,
  OfferType,
  Persona,
  VisualStyle,
} from '@/services/ad-library/label-taxonomy';
import type { JustScaledReason } from './signals';
import type { DeskAnalysis } from './desk';
import type { LandingPagesResult } from './landing-pages';

/** One ad from library_ads_enriched as returned by the brand-identity API. */
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
  /** Permanent R2 image copies aligned by index to media_urls. */
  hosted_media_urls: (string | null)[] | null;
  /** Permanent R2 video copies aligned by index to video_urls. */
  hosted_video_urls: (string | null)[] | null;
  /** Google: actor served-day count; null for Meta. Win-score longevity basis. */
  num_served_days: number | null;
  /** Destination URL scraped from the ad; null for pre-capture rows. */
  landing_url: string | null;
  /** Normalized landing domain — the cross-platform brand-pairing key. */
  landing_domain: string | null;
  raw_ref: string | null;
  first_seen_at: string;
  last_seen_at: string;
  hook_archetype: HookArchetype | null;
  angle: Angle | null;
  /** Industry-specific persona; null until (re)labelled with taxonomy v2. */
  persona: string | null;
  /** Stable universal persona for cross-industry comparison; null pre-v2. */
  persona_universal: Persona | null;
  /** Funnel position; null pre-v2. */
  funnel_stage: FunnelStage | null;
  format: AdFormat | null;
  /** Visual aesthetic of the creative; null pre-fingerprint or text-only labelled. */
  style: VisualStyle | null;
  /** Coarse aspect-ratio bucket derived from the poster dimensions. */
  aspect_ratio: AspectRatio | null;
  /** Visual fingerprint attributes; null without visual context. */
  fingerprint: AdFingerprint | null;
  offer_type: OfferType | null;
  hook_text: string | null;
  summary: string | null;
  confidence: number | null;
  label_model: string | null;
  labeled_at: string | null;
  longevity_days: number;
  is_active: boolean;
}

export interface JustScaledAd extends EnrichedAd {
  scaledReasons: JustScaledReason[];
  /**
   * Distinct variations of this ad's message the competitor is running
   * (cosine-cluster size after collapsing re-runs). Null when the ad has no
   * embedding yet.
   */
  replicationScore: number | null;
  /** Cluster id shared by every ad in the same message family. Null when unembedded. */
  clusterId: string | null;
}

export interface TrackedCompetitor {
  id: string;
  organization_id: string;
  /**
   * Which brand this competitor informs (agency multi-brand orgs). Null =
   * org-shared: visible to every brand, used by market distillation only as
   * the fallback pool for brands with zero tagged competitors.
   */
  brand_profile_id: string | null;
  name: string;
  /**
   * Which ad library this competitor is tracked on — the per-row platform
   * discriminator (one row per platform). Drives the source logo in the UI.
   */
  platform: 'meta' | 'google';
  /** Keyword search term. Null for page-tracked competitors. */
  keyword: string | null;
  /** ISO country code for the Ad Library search. Defaults to 'US'. */
  country: string;
  /** Facebook page handle the user entered (page tracking). Null otherwise. */
  page_ref: string | null;
  /** Meta Page ID — resolved from scraped ads for page tracking. */
  meta_page_id: string | null;
  meta_page_name: string | null;
  /** Google Ads Transparency advertiser id (AR…). Null for Meta competitors. */
  google_advertiser_id: string | null;
  /** Backfilled brand name from scraped Google ads. Null until first sync. */
  google_advertiser_name: string | null;
  status: 'active' | 'paused';
  /**
   * The advertiser's vertical (one of the 16 industry keys), auto-classified at
   * sync and human-overridable. Drives the per-industry angle vocabulary. Null
   * when unclassified — the brand then uses the universal angle list.
   */
  industry: string | null;
  last_synced_at: string | null;
  created_at: string;
  adCount: number;
  labeledCount: number;
  activeCount: number;
  /** Proven winners: still delivering AND past the longevity threshold. */
  winnerCount: number;
  /**
   * True while an `adlib_sync_competitor` job for this competitor is pending or
   * processing. Server-derived so the row shows "Syncing…" regardless of which
   * component triggered the sync (create-and-sync, another tab, or a reload).
   */
  syncing: boolean;
  /**
   * True when the competitor has never synced successfully and its latest sync
   * job failed. Lets the row surface the failure the optimistic "Sync started…"
   * toast hides (e.g. a missing provider token) instead of sitting silently at
   * "synced Never".
   */
  syncFailed: boolean;
}

/* ── Saved ad collections ────────────────────────────────────────────── */

/** A named, org-shared folder of saved competitor ads. */
export interface SavedCollection {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  /** User who created the folder — display attribution only. */
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A collection plus the aggregates the list view needs. */
export interface SavedCollectionSummary extends SavedCollection {
  adCount: number;
  /** Up to a few preview image URLs pulled from the saved ads' snapshots. */
  thumbnails: string[];
  /**
   * Only present when the list was queried with `forAd` — whether THIS ad is
   * already in the collection. Drives the save-to-collection popover checkboxes.
   */
  containsAd?: boolean;
}

/** One ad saved into a collection — the snapshot rendered "later". */
export interface SavedAdItem {
  id: string;
  collection_id: string;
  /** Soft link to the live ad; null once the source ad/competitor is deleted. */
  library_ad_id: string | null;
  external_ad_id: string;
  platform: string;
  competitor_id: string | null;
  notes: string | null;
  saved_at: string;
  /** Denormalized ad, shaped like EnrichedAd so the existing cards/sheet render it. */
  ad: EnrichedAd;
}

export interface SavedCollectionDetail {
  collection: SavedCollection;
  ads: SavedAdItem[];
}

/** Org-wide "platform:external_ad_id" keys for the bookmark filled/outline state. */
export type SavedAdKey = string;

export interface BrandIdentityOverview {
  stats: {
    competitorsTracked: number;
    totalAds: number;
    labeledAds: number;
    activeAds: number;
    provenWinners: number;
  };
  recentlyScaled: EnrichedAd[];
}

/** One member ad of a replication cluster, with the LLM label it independently received. */
export interface ReplicationClusterMember {
  id: string;
  angle: Angle | null;
  hookArchetype: HookArchetype | null;
  adSnapshotUrl: string | null;
  /** The exact copy that was embedded for this ad. */
  snippet: string;
}

/** A group of ads the embedding clustered together by ad-copy cosine similarity. */
export interface ReplicationCluster {
  clusterId: string;
  /** Distinct variations after collapsing exact re-runs. */
  replicationScore: number;
  /** Total ads in the cluster (may exceed members.length, which is capped). */
  size: number;
  /** Distinct LLM angle labels across members — >1 proves grouping ≠ the AI label. */
  angles: Angle[];
  members: ReplicationClusterMember[];
}

export interface CompetitorDetail {
  competitor: Omit<
    TrackedCompetitor,
    'adCount' | 'labeledCount' | 'activeCount' | 'winnerCount'
  >;
  stats: {
    totalAds: number;
    activeAds: number;
    labeledAds: number;
    /** Ads with a persisted copy embedding (participate in replication scoring). */
    embeddedAds: number;
    /** Largest replication score across this competitor's clusters. */
    maxReplicationScore: number;
  };
  newThisWeek: EnrichedAd[];
  justScaled: JustScaledAd[];
  replicationClusters: ReplicationCluster[];
  longevityDistribution: Array<{ bucket: string; label: string; count: number }>;
  /**
   * Analyst's Desk analysis (Creative DNA, launch cadence, survival) over this
   * competitor's full ad set. Additive — consumed only by the gated Desk
   * drill-in; the legacy page ignores it.
   */
  desk: DeskAnalysis;
  /**
   * The competitor's full ad set (newest first), capped at DESK_ALL_ADS_LIMIT,
   * for the keyboard screening wall. Additive to the existing subset fields.
   */
  allAds: EnrichedAd[];
  /**
   * Cross-platform presence: set when this competitor's real-world brand is
   * also tracked on the other platform (paired by dominant landing domain or
   * normalized name) and message-family matching ran. Null when unpaired.
   */
  crossPlatform: {
    pairedCompetitorId: string;
    basis: 'domain' | 'name';
    /** This competitor's ads whose message family also runs on the pair. */
    matchedAdCount: number;
  } | null;
  /**
   * Destination URLs this competitor's ads send traffic to, ranked by winners
   * → ad count → median longevity (`rankLandingPages`). Winners use the same
   * evaluator as the rest of the route. Optional so stale caches stay safe.
   */
  landingPages?: LandingPagesResult;
}

/**
 * Shape of one row from the library_ads_enriched view. confidence comes back
 * as a string (numeric column) and is parsed at this boundary.
 */
export interface EnrichedAdRow {
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
  /** Permanent R2 image copies aligned by index to media_urls. */
  hosted_media_urls: (string | null)[] | null;
  /** Permanent R2 video copies aligned by index to video_urls. */
  hosted_video_urls: (string | null)[] | null;
  /** Google: actor served-day count; null for Meta. Win-score longevity basis. */
  num_served_days: number | null;
  /** Destination URL scraped from the ad; null for pre-capture rows. */
  landing_url: string | null;
  /** Normalized landing domain — the cross-platform brand-pairing key. */
  landing_domain: string | null;
  raw_ref: string | null;
  first_seen_at: string;
  last_seen_at: string;
  hook_archetype: string | null;
  /** Industry-specific angle (vocabulary depends on the competitor's industry). */
  angle: string | null;
  /** Stable global angle for cross-industry comparison; null until (re)labelled. */
  angle_universal: string | null;
  /** Industry-specific persona (vocabulary depends on the competitor's industry); null pre-v2. */
  persona: string | null;
  /** Stable universal persona for cross-industry comparison; null pre-v2. */
  persona_universal: string | null;
  /** Funnel position (label-taxonomy FUNNEL_STAGES); null pre-v2. */
  funnel_stage: string | null;
  format: string | null;
  /** Visual aesthetic (label-taxonomy VISUAL_STYLES); null pre-fingerprint or text-only labelled. */
  style: string | null;
  /** Coarse creative aspect-ratio bucket, derived from the poster dimensions. */
  aspect_ratio: string | null;
  /** AdFingerprint visual attributes (label-taxonomy); null without visual context. */
  fingerprint: Record<string, unknown> | null;
  offer_type: string | null;
  hook_text: string | null;
  summary: string | null;
  confidence: string | number | null;
  label_model: string | null;
  labeled_at: string | null;
  longevity_days: number;
  is_active: boolean;
}

export function serializeEnrichedAd(row: EnrichedAdRow) {
  return {
    ...row,
    confidence: row.confidence === null ? null : Number(row.confidence),
  };
}

/** Canonical media-type filter values ('text' = Google Search ads). Shared by
 *  the API filter module and the library UI so the two can never drift. */
export const AD_MEDIA_TYPES = [
  'image',
  'video',
  'carousel',
  'text',
  'unknown',
] as const;
export type AdMediaType = (typeof AD_MEDIA_TYPES)[number];

export const LIBRARY_SORTS = ['longevity', 'newest', 'reach'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export interface LibraryFilterState {
  competitorIds: string[];
  hookArchetypes: HookArchetype[];
  /** Industry-specific angle values (vocabulary depends on the competitor's industry). */
  angles: string[];
  personasUniversal: Persona[];
  funnelStages: FunnelStage[];
  formats: AdFormat[];
  styles: VisualStyle[];
  offerTypes: OfferType[];
  mediaTypes: AdMediaType[];
  activeOnly: boolean;
  minLongevityDays: number;
  search: string;
  sort: LibrarySort;
  page: number;
}

export interface LibraryListResponse {
  ads: EnrichedAd[];
  pagination: { page: number; pageSize: number; total: number };
}

/* ── Win-score dashboard ─────────────────────────────────────────────── */

/**
 * Dimensions compared via winners-vs-all over-index. All are LLM-label
 * categoricals (clean shared enums). Note `angle` here is the LLM `angle` label
 * — distinct from the embedding-based semantic message-family clusters
 * (`AngleCluster` / AngleClustersPanel), which remain a separate path.
 */
export type OverIndexDimension =
  | 'format'
  | 'hook_archetype'
  | 'offer_type'
  | 'angle'
  | 'angle_universal'
  | 'persona'
  | 'funnel_stage';

/** Visual dimensions the IMAGE per-media quadrant over-indexes across. */
export const IMAGE_QUADRANT_DIMENSIONS = ['style', 'aspect_ratio', 'tone', 'setting'] as const;
/** Visual dimensions the VIDEO per-media quadrant over-indexes across. */
export const VIDEO_QUADRANT_DIMENSIONS = [
  'style',
  'pacing',
  'duration_bucket',
  'tone',
  'aspect_ratio',
] as const;

/** A visual (creative-fingerprint) dimension used only by the per-media quadrants. */
export type MediaQuadrantDimension =
  | 'style'
  | 'aspect_ratio'
  | 'tone'
  | 'setting'
  | 'pacing'
  | 'duration_bucket';

/**
 * Any dimension a DimensionOverIndex can carry: the 7 label dimensions of the
 * main winners-vs-rest panel, plus the visual dimensions of the per-media quadrants.
 */
export type AnalysisDimension = OverIndexDimension | MediaQuadrantDimension;

/** One row of a per-dimension performance breakdown table. */
export interface DimensionBreakdownRow {
  /** Taxonomy value (e.g. 'ugc'); NULL offer_type is bucketed as 'none'. */
  label: string;
  totalCount: number;
  /** Of totalCount, how many are proven winners per the profile-driven
   *  `isWinner` (cohort-relative top quartile above the profile floor). */
  winnerCount: number;
  /** winnerCount / totalCount, 0..1. */
  winRate: number;
  medianLongevity: number;
  /** Mean EU reach over members that report it; null when none do. */
  avgReach: number | null;
  /** Active / totalCount, 0..1. */
  activeShare: number;
  /**
   * Median composite win score (`computeWinScore`, 0..100 — longevity +
   * replication (+ EU reach where reported)) over ALL of this label's ads. The
   * dimension bars' default metric and `buildDimensionBreakdown`'s sort key:
   * unlike `winRate` it credits replication, so a 3-of-3 longevity sweep can't
   * read as 100%. Read from `buildDimensionBreakdown`'s `scoreByAdId`; ads
   * missing from that map score 0 (legacy callers/tests that pass no map get 0
   * everywhere). Same definition as `OverIndexRow.medianWinScore`.
   */
  medianWinScore: number;
}

/** One label's winners-vs-all comparison within a dimension. */
export interface OverIndexRow {
  label: string;
  /** Share of this label among winners, 0..1. */
  winnerShare: number;
  /** Share of this label among all labeled ads, 0..1. */
  allShare: number;
  /** winnerShare / allShare; > 1 means the label over-indexes among winners. */
  lift: number;
  winnerCount: number;
  totalCount: number;
  /** Median longevity_days across this label's ads — the continuous winner signal. */
  medianLongevity: number;
  /** Active / totalCount, 0..1. */
  activeShare: number;
  /**
   * Mean EU reach over members that report it; null when none do. Same
   * definition as `DimensionBreakdownRow.avgReach`. Carried here so the
   * dimension-performance bars can render the per-media visual dimensions,
   * which have no `breakdowns` entry of their own.
   */
  avgReach: number | null;
  /**
   * Id of the top-win-score ad carrying this label — the "top result" the matrix
   * opens when its label is clicked. Resolved to a full ad via the dashboard's
   * `exampleAds` pool. Null only when the group is somehow empty. Equals
   * `exampleAdIds[0]`.
   */
  topAdId: string | null;
  /**
   * All ads carrying this label, win-score-ranked (score → longevity → id asc),
   * capped at `MAX_TACTIC_EXAMPLES`. The matrix opens this whole list so the user
   * can arrow through every example, not just the top one. Each id resolves via
   * the dashboard's `exampleAds` pool.
   */
  exampleAdIds: string[];
  /**
   * Median composite win score (`computeWinScore`, 0..100 — longevity +
   * replication (+ EU reach where reported)) over ALL of this label's ads, not
   * the capped example list. The winners-mode matrix y-axis: unlike win rate it
   * credits replication, so a lone long-running ad can't read as 100%. Read
   * from `buildOverIndexBy`'s `scoreByAdId`; ads missing from that map score 0
   * (legacy callers/tests that pass no map get 0 everywhere).
   */
  medianWinScore: number;
}

export interface DimensionOverIndex {
  dimension: AnalysisDimension;
  rows: OverIndexRow[];
  /**
   * Pooled median win score over every labeled ad in this dimension (all rows
   * together, not a median of row medians) — the winners-mode matrix midline.
   * Same `scoreByAdId` source and 0-default as `OverIndexRow.medianWinScore`.
   */
  medianWinScore: number;
}

/** One media bucket's per-media-type winners-vs-rest quadrant data. */
export interface MediaQuadrantGroup {
  /** Ads in this media bucket (image bucket = media_type 'image' + 'carousel'; video = 'video'). */
  totalAds: number;
  /** Of totalAds, rows labeled WITH visual context (style !== null) — drives the coverage note. */
  visuallyLabeledAds: number;
  overIndex: DimensionOverIndex[];
}

/** Per-media-type over-index quadrants: IMAGE and VIDEO creatives analysed separately. */
export interface MediaQuadrants {
  image: MediaQuadrantGroup;
  video: MediaQuadrantGroup;
}

/** A top winning creative, ranked by composite win score. */
export interface WinningAd {
  ad: EnrichedAd;
  /** Composite win score, 0..100. */
  winScore: number;
  /** Number of ads in this ad's semantic message-family cluster (1 = no cluster). */
  replicationCount: number;
  /** Whether EU reach was available for this ad (drives the score blend + UI). */
  reachAvailable: boolean;
}

/** One member ad of a semantic message-family ("angle") cluster. */
export interface AngleClusterMember {
  ad: EnrichedAd;
  winScore: number;
}

/**
 * A semantic message-family cluster — what we surface as an "angle". Labeled by
 * its most representative member's copy. Replication = how many ads run in it.
 */
export interface AngleCluster {
  clusterId: string;
  /**
   * Representative member's hook text / summary / copy snippet - ad copy or
   * the labeller's model-written summary, i.e. DATA (never translated).
   */
  label: string;
  /** True when `label` is the "Untitled angle" placeholder (chrome, translatable). */
  labelIsPlaceholder?: true;
  /** Ads in the cluster — the headline "they're scaling this angle" number. */
  replicationCount: number;
  winnerCount: number;
  winRate: number;
  medianLongevity: number;
  avgReach: number | null;
  topWinScore: number;
  /** Clusters are per-competitor; carried for the all-competitors view. */
  competitorId: string;
  competitorName: string;
  members: AngleClusterMember[];
}

export interface BrandIdentityDashboard {
  scope: {
    /** null = all-competitors aggregate. */
    competitorId: string | null;
    totalAds: number;
    labeledAds: number;
    activeAds: number;
    provenWinners: number;
    /** Ads with a persisted copy embedding (participate in replication). */
    embeddedAds: number;
  };
  /** Win-score-ranked creatives (hero takes a slice; grid shows all). */
  winners: WinningAd[];
  overIndex: DimensionOverIndex[];
  breakdowns: Record<OverIndexDimension, DimensionBreakdownRow[]>;
  /** Per-media-type visual over-index quadrants (IMAGE vs VIDEO creatives). */
  mediaQuadrants: MediaQuadrants;
  /** Top semantic message-family clusters ("angles"), ranked by replication. */
  angleClusters: AngleCluster[];
  /**
   * Deduped pool of the ads referenced by any over-index row's `topAdId` (main
   * panel + per-media quadrants). The matrix resolves a clicked label's
   * `topAdId` against this pool to open that tactic's top ad.
   */
  exampleAds: EnrichedAd[];
}

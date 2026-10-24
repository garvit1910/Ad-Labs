import { median } from './math';
import { parseLandingDestination } from './landing-pages';
import { groupNearDuplicates } from '@/services/ad-library/near-duplicates';
import {
  clusterByCosine,
  type ClusterAssignment,
  type ClusterInput,
} from './clustering';
import { LONGEVITY_BUCKETS, longevityBucket } from './longevity';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A longevity threshold counts as "recently crossed" for this many days. */
const CROSSING_WINDOW_DAYS = 7;
/** Reach this many times the competitor median counts as a spike. */
const REACH_SPIKE_MULTIPLIER = 3;
const DUPLICATE_MIN_CLUSTER = 3;
const DUPLICATE_LAUNCH_WINDOW_DAYS = 7;
/**
 * A new format of an existing message family counts as an expansion for this
 * long after its first ad launched. Wider than CROSSING_WINDOW_DAYS because
 * competitor syncs run ~monthly (ADLIB_MONTHLY_CADENCE_DAYS) — a 7-day window
 * would miss most expansions that happened between two syncs.
 */
const FORMAT_EXPANSION_WINDOW_DAYS = 30;
/**
 * The base format must have at least one member this old before a new format
 * reads as "porting a proven concept" — a simultaneous multi-format launch is
 * a normal creative drop, not an expansion.
 */
const FORMAT_EXPANSION_MIN_BASE_DAYS = 14;
/** Media types that participate in format-expansion detection. */
const EXPANSION_MEDIA_TYPES = new Set(['image', 'video', 'carousel', 'text']);
/**
 * Cluster momentum: an established message family that gained this many new
 * variants within the window is being actively doubled down on. Window matches
 * the monthly sync cadence (same reasoning as FORMAT_EXPANSION_WINDOW_DAYS).
 */
const MOMENTUM_WINDOW_DAYS = 30;
const MOMENTUM_MIN_RECENT = 2;
/**
 * Cluster survivor: an active ad whose siblings were mostly culled is the
 * SELECTED survivor of a variant test. Needs a real test (min cluster size),
 * a mostly-culled cluster (max active share), and the survivor must have run
 * alongside the culled siblings (min longevity — a fresh variant added to a
 * legacy pile is momentum, not survival).
 */
const SURVIVOR_MIN_CLUSTER = 4;
const SURVIVOR_MAX_ACTIVE_SHARE = 1 / 3;
const SURVIVOR_MIN_LONGEVITY_DAYS = 14;
/**
 * Survivor detection is only meaningful while `is_active` is trustworthy: the
 * enriched view derives it from a 32-day `last_seen_at` freshness window, so a
 * competitor whose sync is overdue reads 100% inactive and survival collapses
 * to noise. Routes gate `clusterSurvivalEligible` on this window (coupled to
 * the view SQL in drizzle/schema.ts — change them together) and on platform:
 * Google's 5-day staleness inference makes its is_active unusable here.
 */
export const SURVIVAL_FRESHNESS_DAYS = 32;
/**
 * Dedicated landing page: a message family whose members share one non-root
 * landing path has a funnel built for that angle. The path must not be the
 * competitor's default destination (global-share cap) — a brand that sends
 * every ad to one PDP is not signaling per-angle investment.
 *
 * INVARIANT: the minimum counts ADS ACTUALLY ON THE SHARED PATH, not the
 * cluster's URL-bearing member count. Both gates apply — at least this many
 * members point at the path AND they are at least the share of the cluster's
 * URL-bearing members — so a two-ad path can never qualify by riding a small
 * cluster's share arithmetic.
 */
const DEDICATED_LANDING_MIN_PATH_ADS = 3;
const DEDICATED_LANDING_MIN_CLUSTER_SHARE = 0.6;
const DEDICATED_LANDING_MAX_GLOBAL_SHARE = 0.5;

/** The subset of library_ads_enriched columns the signal helpers need. */
export interface SignalAd {
  id: string;
  creative_bodies: string[] | null;
  first_seen_at: string;
  delivery_start: string;
  eu_total_reach: number | null;
  longevity_days: number;
  is_active: boolean;
  media_type: string | null;
  /** Destination URL (migration 0136); optional so legacy callers still fit. */
  landing_url?: string | null;
}

export type JustScaledReason =
  | 'crossed_30d'
  | 'crossed_60d'
  | 'reach_spike'
  | 'duplicated_creative'
  | 'format_expansion'
  | 'cross_platform'
  | 'cluster_momentum'
  | 'cluster_survivor'
  | 'dedicated_landing';

/** Optional cluster/cross-platform context enabling the newer signals. */
export interface JustScaledContext {
  /**
   * computeReplication output for the same rowset. Absent ⇒ format_expansion
   * detection is skipped (ads without embeddings never participate either way).
   */
  clusterAssignments?: Map<string, ClusterAssignment>;
  /**
   * Ads whose message family also runs on the paired competitor's other
   * platform (computeCrossPlatformMatches). Absent ⇒ no cross_platform reason.
   */
  crossPlatformAdIds?: Set<string>;
  /**
   * Enables cluster_survivor detection. Routes must gate this on platform
   * (Meta only) and sync freshness (SURVIVAL_FRESHNESS_DAYS) — see the
   * constant's doc. Absent/false ⇒ no cluster_survivor reason.
   */
  clusterSurvivalEligible?: boolean;
  /** Injectable clock for tests; defaults to the current time. */
  now?: Date;
}

function daysAgo(now: Date, iso: string): number {
  return (now.getTime() - new Date(iso).getTime()) / DAY_MS;
}

/**
 * Clusters of >= 3 near-duplicate creatives launched within a one-week
 * window. Launching several lightly edited variants at once is the
 * cheapest reliable "they are scaling this" tell.
 */
export function findScalingClusters(ads: SignalAd[]): Map<string, string[]> {
  const clusters = groupNearDuplicates(
    ads.map((ad) => ({
      id: ad.id,
      creativeBodies: ad.creative_bodies ?? [],
      firstSeenAt: ad.first_seen_at,
    })),
    DUPLICATE_MIN_CLUSTER
  );

  const adToCluster = new Map<string, string[]>();
  const startById = new Map(ads.map((ad) => [ad.id, ad.delivery_start]));
  for (const cluster of clusters) {
    const starts = cluster.adIds
      .map((id) => new Date(startById.get(id) ?? 0).getTime())
      .sort((a, b) => a - b);
    const spreadDays = (starts[starts.length - 1] - starts[0]) / DAY_MS;
    if (spreadDays > DUPLICATE_LAUNCH_WINDOW_DAYS) continue;
    for (const id of cluster.adIds) {
      adToCluster.set(id, cluster.adIds);
    }
  }
  return adToCluster;
}

/**
 * Message families (embedding clusters) that expanded into a new media format:
 * the concept ran in a proven base format first, then a later ad introduced a
 * second format (static → video, video → carousel, …) recently. Returns the
 * expansion-format members — they are the news, not the base ads.
 */
export function findFormatExpansions(
  ads: SignalAd[],
  clusterAssignments: Map<string, ClusterAssignment>,
  now: Date
): Set<string> {
  const clusters = new Map<string, SignalAd[]>();
  for (const ad of ads) {
    const assignment = clusterAssignments.get(ad.id);
    if (!assignment) continue;
    if (!ad.media_type || !EXPANSION_MEDIA_TYPES.has(ad.media_type)) continue;
    const members = clusters.get(assignment.clusterId);
    if (members) members.push(ad);
    else clusters.set(assignment.clusterId, [ad]);
  }

  const expanded = new Set<string>();
  for (const members of clusters.values()) {
    const byFormat = new Map<string, SignalAd[]>();
    for (const member of members) {
      const bucket = byFormat.get(member.media_type as string);
      if (bucket) bucket.push(member);
      else byFormat.set(member.media_type as string, [member]);
    }
    if (byFormat.size < 2) continue;

    const earliestStart = (bucket: SignalAd[]): number =>
      Math.min(...bucket.map((m) => new Date(m.delivery_start).getTime()));
    let baseFormat: string | null = null;
    let baseStart = Infinity;
    for (const [format, bucket] of byFormat) {
      const start = earliestStart(bucket);
      if (start < baseStart) {
        baseStart = start;
        baseFormat = format;
      }
    }
    if (!baseFormat) continue;

    // The concept must be proven in its base format before a new format
    // counts as scaling — otherwise a day-one multi-format drop qualifies.
    const baseProven = (byFormat.get(baseFormat) ?? []).some(
      (m) => m.longevity_days >= FORMAT_EXPANSION_MIN_BASE_DAYS
    );
    if (!baseProven) continue;

    for (const [format, bucket] of byFormat) {
      if (format === baseFormat) continue;
      const start = earliestStart(bucket);
      if (start <= baseStart) continue;
      const ageDays = (now.getTime() - start) / DAY_MS;
      if (ageDays > FORMAT_EXPANSION_WINDOW_DAYS) continue;
      for (const member of bucket) expanded.add(member.id);
    }
  }
  return expanded;
}

/** Groups ads by their embedding cluster; ads without an assignment are absent. */
function groupByCluster(
  ads: SignalAd[],
  clusterAssignments: Map<string, ClusterAssignment>
): Map<string, SignalAd[]> {
  const clusters = new Map<string, SignalAd[]>();
  for (const ad of ads) {
    const assignment = clusterAssignments.get(ad.id);
    if (!assignment) continue;
    const members = clusters.get(assignment.clusterId);
    if (members) members.push(ad);
    else clusters.set(assignment.clusterId, [ad]);
  }
  return clusters;
}

/**
 * Message families with fresh variants on top of an established base: at least
 * MOMENTUM_MIN_RECENT members launched within the window while at least one
 * member predates it. A cluster whose members ALL launched recently is a
 * normal creative drop (duplicated_creative territory), not momentum. Returns
 * the recent members — they are the news.
 */
export function findClusterMomentum(
  ads: SignalAd[],
  clusterAssignments: Map<string, ClusterAssignment>,
  now: Date
): Set<string> {
  const flagged = new Set<string>();
  for (const members of groupByCluster(ads, clusterAssignments).values()) {
    const recent = members.filter(
      (m) => daysAgo(now, m.delivery_start) <= MOMENTUM_WINDOW_DAYS
    );
    if (recent.length < MOMENTUM_MIN_RECENT) continue;
    if (recent.length === members.length) continue; // no established base
    for (const member of recent) flagged.add(member.id);
  }
  return flagged;
}

/**
 * Active ads whose message-family siblings were mostly culled — the selected
 * survivors of a variant test. Only meaningful when is_active is trustworthy;
 * callers gate via JustScaledContext.clusterSurvivalEligible.
 */
export function findClusterSurvivors(
  ads: SignalAd[],
  clusterAssignments: Map<string, ClusterAssignment>
): Set<string> {
  const flagged = new Set<string>();
  for (const members of groupByCluster(ads, clusterAssignments).values()) {
    if (members.length < SURVIVOR_MIN_CLUSTER) continue;
    const active = members.filter((m) => m.is_active);
    if (active.length === 0) continue;
    if (active.length / members.length > SURVIVOR_MAX_ACTIVE_SHARE) continue;
    for (const member of active) {
      // A fresh variant dropped into a mostly-dead cluster did not survive the
      // test — it arrived after it.
      if (member.longevity_days < SURVIVOR_MIN_LONGEVITY_DAYS) continue;
      flagged.add(member.id);
    }
  }
  return flagged;
}

/**
 * Lowercased pathname without trailing slashes; null when unparseable. Tracker
 * wrappers are resolved to their destination first, and a wrapper host that
 * survives unwrapping yields null: `/pagead/aclk` or `/l.php` is a shared
 * routing path every advertiser hits, never a dedicated per-angle funnel.
 */
function normalizeLandingPath(url: string | null | undefined): string | null {
  // Same unwrap + tracker-host rejection as the landing-pages ranking.
  const parsed = parseLandingDestination(url);
  if (!parsed) return null;
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

/**
 * Members of a message family that shares one dedicated (non-root) landing
 * path — a funnel built for that specific angle. The dominant path must not be
 * the competitor's overall default destination, so "every ad goes to the same
 * PDP" never qualifies.
 */
export function findDedicatedLandingAds(
  ads: SignalAd[],
  clusterAssignments: Map<string, ClusterAssignment>
): Set<string> {
  const globalPathCounts = new Map<string, number>();
  let globalUrlBearing = 0;
  for (const ad of ads) {
    const path = normalizeLandingPath(ad.landing_url);
    if (!path) continue;
    globalUrlBearing += 1;
    globalPathCounts.set(path, (globalPathCounts.get(path) ?? 0) + 1);
  }
  if (globalUrlBearing === 0) return new Set();

  const flagged = new Set<string>();
  for (const members of groupByCluster(ads, clusterAssignments).values()) {
    const byPath = new Map<string, SignalAd[]>();
    let urlBearing = 0;
    for (const member of members) {
      const path = normalizeLandingPath(member.landing_url);
      if (!path) continue;
      urlBearing += 1;
      const bucket = byPath.get(path);
      if (bucket) bucket.push(member);
      else byPath.set(path, [member]);
    }
    // Cheap short-circuit: no bucket can reach the minimum in a smaller cluster.
    if (urlBearing < DEDICATED_LANDING_MIN_PATH_ADS) continue;
    for (const [path, bucket] of byPath) {
      if (path === '/') continue;
      if (bucket.length < DEDICATED_LANDING_MIN_PATH_ADS) continue;
      if (bucket.length / urlBearing < DEDICATED_LANDING_MIN_CLUSTER_SHARE) {
        continue;
      }
      const globalShare = (globalPathCounts.get(path) ?? 0) / globalUrlBearing;
      if (globalShare > DEDICATED_LANDING_MAX_GLOBAL_SHARE) continue;
      for (const member of bucket) flagged.add(member.id);
    }
  }
  return flagged;
}

/**
 * "Just scaled" detection per ad. Reasons:
 * - crossed_30d / crossed_60d: still active and the longevity threshold was
 *   crossed within the last week
 * - reach_spike: active with reach >= 3x the competitor median (we keep no
 *   reach history yet, so relative standing approximates a jump)
 * - duplicated_creative: member of a >= 3 near-duplicate cluster launched
 *   within one week
 * - format_expansion: member of the new format of a message family that
 *   expanded formats recently (needs context.clusterAssignments)
 * - cross_platform: the ad's message family also runs on the brand's paired
 *   other-platform competitor (needs context.crossPlatformAdIds)
 * - cluster_momentum: fresh variant of an established message family that
 *   gained >= 2 variants in 30 days (needs context.clusterAssignments)
 * - cluster_survivor: active ad in a mostly-culled message family — the
 *   selected survivor of a variant test (needs context.clusterAssignments
 *   AND context.clusterSurvivalEligible)
 * - dedicated_landing: member of a message family sharing a dedicated non-root
 *   landing path that is not the competitor's default destination (needs
 *   context.clusterAssignments + landing_url on the ads)
 */
export function computeJustScaled(
  ads: SignalAd[],
  context: JustScaledContext = {}
): Map<string, JustScaledReason[]> {
  const reasons = new Map<string, JustScaledReason[]>();
  const add = (id: string, reason: JustScaledReason) => {
    const existing = reasons.get(id);
    if (existing) {
      existing.push(reason);
    } else {
      reasons.set(id, [reason]);
    }
  };

  const medianReach = median(
    ads
      .map((ad) => ad.eu_total_reach ?? 0)
      .filter((reach) => reach > 0)
  );

  for (const ad of ads) {
    if (ad.is_active) {
      if (
        ad.longevity_days >= 60 &&
        ad.longevity_days < 60 + CROSSING_WINDOW_DAYS
      ) {
        add(ad.id, 'crossed_60d');
      } else if (
        ad.longevity_days >= 30 &&
        ad.longevity_days < 30 + CROSSING_WINDOW_DAYS
      ) {
        add(ad.id, 'crossed_30d');
      }
      if (
        medianReach > 0 &&
        (ad.eu_total_reach ?? 0) >= medianReach * REACH_SPIKE_MULTIPLIER
      ) {
        add(ad.id, 'reach_spike');
      }
    }
  }

  for (const id of findScalingClusters(ads).keys()) {
    add(id, 'duplicated_creative');
  }

  if (context.clusterAssignments) {
    const now = context.now ?? new Date();
    for (const id of findFormatExpansions(ads, context.clusterAssignments, now)) {
      add(id, 'format_expansion');
    }
    for (const id of findClusterMomentum(ads, context.clusterAssignments, now)) {
      add(id, 'cluster_momentum');
    }
    if (context.clusterSurvivalEligible) {
      for (const id of findClusterSurvivors(ads, context.clusterAssignments)) {
        add(id, 'cluster_survivor');
      }
    }
    for (const id of findDedicatedLandingAds(ads, context.clusterAssignments)) {
      add(id, 'dedicated_landing');
    }
  }

  if (context.crossPlatformAdIds) {
    for (const ad of ads) {
      if (context.crossPlatformAdIds.has(ad.id)) {
        add(ad.id, 'cross_platform');
      }
    }
  }

  return reasons;
}

/** A persisted copy embedding plus the model that produced it. */
export interface AdVector {
  vector: number[];
  embeddingModel: string;
}

/**
 * Replication score per ad via cosine clustering of copy embeddings (the v2
 * upgrade over normalized-copy grouping — robust to label quality). Only ads
 * with a persisted vector participate; ads still awaiting their embedding are
 * absent from the returned map (the caller renders them as "not yet scored"
 * rather than 0). Clustering is per competitor, so each ad must carry its
 * competitor_id.
 *
 * `currentModel` enforces the same-model invariant: vectors produced by any
 * other embedding model (a model swap without a full re-index) are dropped
 * before clustering rather than compared against current-model vectors — see
 * `clusterByCosine`.
 */
export function computeReplication(
  ads: Array<{ id: string; competitor_id: string }>,
  vectors: Map<string, AdVector>,
  currentModel: string
): Map<string, ClusterAssignment> {
  const items: ClusterInput[] = [];
  for (const ad of ads) {
    const entry = vectors.get(ad.id);
    if (entry) {
      items.push({
        id: ad.id,
        competitorId: ad.competitor_id,
        embeddingModel: entry.embeddingModel,
        vector: entry.vector,
      });
    }
  }
  return clusterByCosine(items, currentModel);
}

export function computeLongevityDistribution(
  ads: SignalAd[]
): Array<{ bucket: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const ad of ads) {
    const bucket = longevityBucket(ad.longevity_days);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return LONGEVITY_BUCKETS.map(({ key, label }) => ({
    bucket: key,
    label,
    count: counts.get(key) ?? 0,
  }));
}

/**
 * Overview "recently scaled" strip: ads launched in the last 14 days that
 * are either in a near-duplicate cluster or lead on reach.
 */
export function computeRecentlyScaled(
  ads: SignalAd[],
  now: Date,
  limit = 12
): string[] {
  const recent = ads.filter(
    (ad) => ad.is_active && daysAgo(now, ad.delivery_start) <= 14
  );
  const clusterIds = findScalingClusters(recent);
  const ranked = [...recent].sort((a, b) => {
    const aClustered = clusterIds.has(a.id) ? 1 : 0;
    const bClustered = clusterIds.has(b.id) ? 1 : 0;
    if (aClustered !== bClustered) return bClustered - aClustered;
    return (b.eu_total_reach ?? 0) - (a.eu_total_reach ?? 0);
  });
  return ranked.slice(0, limit).map((ad) => ad.id);
}

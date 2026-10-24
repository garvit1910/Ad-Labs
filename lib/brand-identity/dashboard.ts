/**
 * Pure aggregation for the Brand Identity win-score dashboard. Takes enriched
 * library rows plus the read-time replication clustering and produces:
 *  - top winning creatives ranked by composite win score
 *  - per-dimension performance breakdowns (format / hook / offer / angle — LLM labels)
 *  - winners-vs-all over-index for those same dimensions
 *  - top semantic message-family clusters (embedding "angles"), where replication
 *    is the number of ads the brand runs in one cluster — a SEPARATE path from the
 *    LLM `angle` label dimension above
 *
 * No DB, no React — the API route loads the data and serializes the carried
 * rows; the unit tests exercise these functions directly.
 */

import { mean, median } from './math';
import { firstRealBody } from './creative-text';
import type { ClusterAssignment } from './clustering';
import type {
  DimensionBreakdownRow,
  EnrichedAdRow,
  DimensionOverIndex,
  MediaQuadrants,
  OverIndexDimension,
} from './types';
import { buildMediaQuadrants, buildOverIndexBy } from './media-quadrants';
import {
  buildCohortThresholds,
  computeWinScore,
  isWinner,
  type ScorableAd,
} from './win-score';
import {
  adSurface,
  cohortKey,
  META_PROFILE,
  resolveWinProfile,
  type BrandType,
  type WinProfile,
} from './win-profile';

export const OVER_INDEX_DIMENSIONS: readonly OverIndexDimension[] = [
  'format',
  'hook_archetype',
  'offer_type',
  'angle',
  'angle_universal',
  'persona',
  'funnel_stage',
];

export interface ScopedStatsCompetitor {
  id: string;
  platform: 'meta' | 'google';
  adCount: number;
  labeledCount: number;
  activeCount: number;
  winnerCount: number;
}

/**
 * The 5 stat-card numbers for the current dashboard filter, summed from the
 * per-competitor counts the competitors/list route returns. Mirrors the
 * dashboard route's `scope` (same source view, same definitions): one
 * competitor selected ⇒ just that competitor; else every competitor matching
 * the platform filter ('all' ⇒ all). tracked_competitors has one row per
 * platform, so a competitor's ads are all on its platform — letting the cards
 * stay in sync without the heavy embeddings/clustering dashboard fetch.
 */
export function computeScopedStats(
  competitors: ScopedStatsCompetitor[],
  opts: { competitorId?: string; platform: 'meta' | 'google' | 'all' }
) {
  const scoped = competitors.filter((c) =>
    opts.competitorId
      ? c.id === opts.competitorId
      : opts.platform === 'all' || c.platform === opts.platform
  );
  return {
    competitorsTracked: scoped.length,
    totalAds: scoped.reduce((s, c) => s + c.adCount, 0),
    labeledAds: scoped.reduce((s, c) => s + c.labeledCount, 0),
    activeAds: scoped.reduce((s, c) => s + c.activeCount, 0),
    provenWinners: scoped.reduce((s, c) => s + c.winnerCount, 0),
  };
}

/** The scoped stat-card numbers (see `computeScopedStats`). */
export type ScopedStats = ReturnType<typeof computeScopedStats>;

const LABEL_MAX_CHARS = 90;

/* ── internal (row-carrying) shapes; the route serializes the rows ─────── */

export interface WinnerInternal {
  ad: EnrichedAdRow;
  winScore: number;
  replicationCount: number;
  reachAvailable: boolean;
}

export interface AngleClusterMemberInternal {
  ad: EnrichedAdRow;
  winScore: number;
}

export interface AngleClusterInternal {
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
  members: AngleClusterMemberInternal[];
}

export interface DashboardInternal {
  winners: WinnerInternal[];
  overIndex: DimensionOverIndex[];
  breakdowns: Record<OverIndexDimension, DimensionBreakdownRow[]>;
  /** Per-media-type visual over-index quadrants (IMAGE vs VIDEO creatives). */
  mediaQuadrants: MediaQuadrants;
  angleClusters: AngleClusterInternal[];
  /** Deduped ads referenced by any over-index row's `topAdId` (unserialized). */
  exampleAds: EnrichedAdRow[];
  /** The evaluator built over the scoped rows — routes reuse it (and
   *  `provenWinners`) instead of building a second one for the KPI. */
  evaluator: WinnerEvaluator;
  /** Winner count over the scoped rows, classified once per ad. */
  provenWinners: number;
}

/* ── small helpers ─────────────────────────────────────────────────────── */

/**
 * The dimension value used for grouping. offer_type NULL maps to 'none' (a real
 * taxonomy value); for format/hook_archetype an unlabeled NULL is excluded.
 */
function dimensionValue(row: EnrichedAdRow, dimension: OverIndexDimension): string | null {
  const raw = row[dimension];
  if (dimension === 'offer_type') return raw ?? 'none';
  return raw;
}

/** Representative copy for a cluster: hook text → summary → first real body. */
/** Placeholder cluster label (flagged on the cluster so the UI can translate it). */
const UNTITLED_ANGLE = 'Untitled angle';

function clusterLabel(row: EnrichedAdRow): string {
  const text =
    row.hook_text?.trim() ||
    row.summary?.trim() ||
    firstRealBody(row.creative_bodies) ||
    '';
  if (!text) return UNTITLED_ANGLE;
  return text.length > LABEL_MAX_CHARS
    ? `${text.slice(0, LABEL_MAX_CHARS).trimEnd()}…`
    : text;
}

/* ── cluster sizing ─────────────────────────────────────────────────────── */

/**
 * Counts ads per semantic cluster. Replication = cluster size. Ads with no
 * embedding are absent from `replication`, so the caller treats them as size 1.
 */
export function buildClusterSizeIndex(replication: Map<string, ClusterAssignment>): {
  sizeByCluster: Map<string, number>;
  sizeByAd: Map<string, number>;
} {
  const sizeByCluster = new Map<string, number>();
  for (const { clusterId } of replication.values()) {
    sizeByCluster.set(clusterId, (sizeByCluster.get(clusterId) ?? 0) + 1);
  }
  const sizeByAd = new Map<string, number>();
  for (const [adId, { clusterId }] of replication) {
    sizeByAd.set(adId, sizeByCluster.get(clusterId) ?? 1);
  }
  return { sizeByCluster, sizeByAd };
}

/* ── per-ad profile + winner evaluator ──────────────────────────────────── */

/**
 * Resolves the win profile and winner test for each ad. Built once per dashboard
 * load from the scoped rows + per-competitor brand types, then handed to every
 * aggregation consumer so the profile/cohort logic lives in one place.
 */
/** Minimal ad shape the winner evaluator needs — EnrichedAdRow satisfies it,
 *  and the competitors-list route can satisfy it with a narrow column select. */
export type WinnerEvalRow = ScorableAd & {
  id: string;
  competitor_id: string;
  platform: string;
  media_type: string | null;
};

export interface WinnerEvaluator {
  profileFor(_ad: { id: string }): WinProfile;
  isWinner(_ad: WinnerEvalRow): boolean;
}

/** Meta-profile default WITHOUT cohort thresholds — degrades to the floor
 *  alone (`is_active && >= 30d`, see isWinner). Only for consumers called
 *  directly (e.g. unit tests) without a built evaluator; every real winner
 *  surface must classify through `buildWinnerEvaluator`. */
export const META_EVALUATOR: WinnerEvaluator = {
  profileFor: () => META_PROFILE,
  isWinner: (ad) => isWinner(ad),
};

export function buildWinnerEvaluator(
  rows: WinnerEvalRow[],
  brandTypeByCompetitor: Map<string, BrandType>
): WinnerEvaluator {
  const brandOf = (ad: WinnerEvalRow): BrandType =>
    brandTypeByCompetitor.get(ad.competitor_id) ?? 'unknown';
  const profileById = new Map<string, WinProfile>();
  const keyById = new Map<string, string>();
  for (const ad of rows) {
    const brandType = brandOf(ad);
    profileById.set(
      ad.id,
      resolveWinProfile({ platform: ad.platform, brandType, surface: adSurface(ad) })
    );
    keyById.set(ad.id, cohortKey(ad));
  }
  const thresholds = buildCohortThresholds(
    rows,
    (ad) => keyById.get(ad.id) ?? '',
    (ad) => profileById.get(ad.id) ?? META_PROFILE
  );
  return {
    profileFor: (ad) => profileById.get(ad.id) ?? META_PROFILE,
    isWinner: (ad) =>
      isWinner(ad, profileById.get(ad.id) ?? META_PROFILE, {
        thresholds,
        key: keyById.get(ad.id) ?? '',
      }),
  };
}

/* ── winners ─────────────────────────────────────────────────────────────── */

export function selectTopWinners(
  rows: EnrichedAdRow[],
  sizeByAd: Map<string, number>,
  limit: number,
  evaluator: WinnerEvaluator = META_EVALUATOR
): WinnerInternal[] {
  return rows
    .map((ad) => {
      const replicationCount = sizeByAd.get(ad.id) ?? 1;
      return {
        ad,
        winScore: computeWinScore(ad, replicationCount, evaluator.profileFor(ad)),
        replicationCount,
        reachAvailable: ad.eu_total_reach != null,
      };
    })
    .sort(
      (a, b) =>
        b.winScore - a.winScore ||
        b.ad.longevity_days - a.ad.longevity_days ||
        (a.ad.id < b.ad.id ? -1 : 1)
    )
    .slice(0, limit);
}

/* ── dimension breakdowns ───────────────────────────────────────────────── */

/**
 * Per-label performance for one LLM-label dimension. `scoreByAdId` (the same
 * `computeWinScore` map `buildOverIndex` reads) feeds each row's
 * `medianWinScore`; ads missing from it score 0. Rows sort by median win score,
 * then volume, then label - the bars' default metric, not the longevity-only
 * win rate.
 */
export function buildDimensionBreakdown(
  rows: EnrichedAdRow[],
  dimension: OverIndexDimension,
  evaluator: WinnerEvaluator = META_EVALUATOR,
  scoreByAdId: Map<string, number> = new Map()
): DimensionBreakdownRow[] {
  const groups = new Map<string, EnrichedAdRow[]>();
  for (const row of rows) {
    const value = dimensionValue(row, dimension);
    if (value === null) continue;
    const arr = groups.get(value);
    if (arr) arr.push(row);
    else groups.set(value, [row]);
  }

  const out: DimensionBreakdownRow[] = [];
  for (const [label, group] of groups) {
    const winnerCount = group.filter((r) => evaluator.isWinner(r)).length;
    const reaches = group
      .map((r) => r.eu_total_reach)
      .filter((r): r is number => r != null);
    out.push({
      label,
      totalCount: group.length,
      winnerCount,
      winRate: group.length ? winnerCount / group.length : 0,
      medianLongevity: median(group.map((r) => r.longevity_days)),
      avgReach: mean(reaches),
      activeShare: group.length
        ? group.filter((r) => r.is_active).length / group.length
        : 0,
      medianWinScore: median(group.map((r) => scoreByAdId.get(r.id) ?? 0)),
    });
  }
  out.sort(
    (a, b) =>
      b.medianWinScore - a.medianWinScore ||
      b.totalCount - a.totalCount ||
      (a.label < b.label ? -1 : 1)
  );
  return out;
}

/* ── over-index (winners vs the rest) ───────────────────────────────────── */

export function buildOverIndex(
  rows: EnrichedAdRow[],
  dimension: OverIndexDimension,
  evaluator: WinnerEvaluator = META_EVALUATOR,
  scoreByAdId: Map<string, number> = new Map()
): DimensionOverIndex {
  // Thin delegate over the generalized core (media-quadrants.ts); the LLM-label
  // grouping is just `dimensionValue`. `scoreByAdId` picks each row's top ad.
  return buildOverIndexBy(
    rows,
    dimension,
    (row) => dimensionValue(row, dimension),
    evaluator,
    scoreByAdId
  );
}

/* ── semantic angle clusters ────────────────────────────────────────────── */

export function buildAngleClusters(
  rows: EnrichedAdRow[],
  replication: Map<string, ClusterAssignment>,
  sizeByAd: Map<string, number>,
  competitorNames: Map<string, string>,
  limit: number,
  memberLimit = 6,
  evaluator: WinnerEvaluator = META_EVALUATOR
): AngleClusterInternal[] {
  const byCluster = new Map<string, EnrichedAdRow[]>();
  for (const row of rows) {
    const assignment = replication.get(row.id);
    if (!assignment) continue;
    const arr = byCluster.get(assignment.clusterId);
    if (arr) arr.push(row);
    else byCluster.set(assignment.clusterId, [row]);
  }

  const clusters: AngleClusterInternal[] = [];
  for (const [clusterId, group] of byCluster) {
    if (group.length < 2) continue; // a singleton is not an "angle they run"

    const scored = group
      .map((ad) => ({
        ad,
        winScore: computeWinScore(ad, sizeByAd.get(ad.id) ?? 1, evaluator.profileFor(ad)),
      }))
      .sort(
        (a, b) =>
          b.winScore - a.winScore ||
          b.ad.longevity_days - a.ad.longevity_days ||
          (a.ad.id < b.ad.id ? -1 : 1)
      );

    const representative = scored[0].ad;
    const winnerCount = group.filter((r) => evaluator.isWinner(r)).length;
    const reaches = group
      .map((r) => r.eu_total_reach)
      .filter((r): r is number => r != null);
    const competitorId = representative.competitor_id;

    const label = clusterLabel(representative);
    clusters.push({
      clusterId,
      label,
      ...(label === UNTITLED_ANGLE ? { labelIsPlaceholder: true as const } : {}),
      replicationCount: group.length,
      winnerCount,
      winRate: winnerCount / group.length,
      medianLongevity: median(group.map((r) => r.longevity_days)),
      avgReach: mean(reaches),
      topWinScore: scored[0].winScore,
      competitorId,
      competitorName: competitorNames.get(competitorId) ?? 'Unknown',
      members: scored.slice(0, memberLimit),
    });
  }

  clusters.sort(
    (a, b) =>
      b.replicationCount - a.replicationCount ||
      b.topWinScore - a.topWinScore ||
      (a.clusterId < b.clusterId ? -1 : 1)
  );
  return clusters.slice(0, limit);
}

/* ── top-level assembly ─────────────────────────────────────────────────── */

export function buildDashboard(
  rows: EnrichedAdRow[],
  replication: Map<string, ClusterAssignment>,
  competitorNames: Map<string, string>,
  opts: { gridLimit: number; clusterLimit: number },
  brandTypeByCompetitor: Map<string, BrandType> = new Map()
): DashboardInternal {
  const { sizeByAd } = buildClusterSizeIndex(replication);
  const evaluator = buildWinnerEvaluator(rows, brandTypeByCompetitor);

  // Classify each ad exactly once; every consumer below (7 dimensions × 2
  // passes + clusters + the routes' KPI) reads the memoized answer.
  const winnerIds = new Set(
    rows.filter((row) => evaluator.isWinner(row)).map((row) => row.id)
  );
  const memoEvaluator: WinnerEvaluator = {
    profileFor: evaluator.profileFor,
    isWinner: (ad) => winnerIds.has(ad.id),
  };

  // Win score per ad — the same signal that ranks the winners grid — so each
  // over-index label can name its top ad (the matrix's clickable "top result")
  // and both the matrix and the dimension bars can plot median win score.
  const scoreByAdId = new Map(
    rows.map((row) => [
      row.id,
      computeWinScore(row, sizeByAd.get(row.id) ?? 1, memoEvaluator.profileFor(row)),
    ])
  );

  const overIndex = OVER_INDEX_DIMENSIONS.map((d) =>
    buildOverIndex(rows, d, memoEvaluator, scoreByAdId)
  );
  const mediaQuadrants = buildMediaQuadrants(rows, memoEvaluator, scoreByAdId);

  // Deduped pool of every tactic's ranked example ads, so the client resolves a
  // clicked label's `exampleAdIds` (arrow-through list) without a per-click fetch.
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const exampleIds = new Set<string>();
  for (const dim of overIndex) {
    for (const r of dim.rows) for (const id of r.exampleAdIds) exampleIds.add(id);
  }
  for (const group of [mediaQuadrants.image, mediaQuadrants.video]) {
    for (const dim of group.overIndex) {
      for (const r of dim.rows)
        for (const id of r.exampleAdIds) exampleIds.add(id);
    }
  }
  const exampleAds = [...exampleIds]
    .map((id) => rowById.get(id))
    .filter((row): row is EnrichedAdRow => row !== undefined);

  const breakdown = (d: OverIndexDimension) =>
    buildDimensionBreakdown(rows, d, memoEvaluator, scoreByAdId);

  return {
    winners: selectTopWinners(rows, sizeByAd, opts.gridLimit, memoEvaluator),
    overIndex,
    breakdowns: {
      format: breakdown('format'),
      hook_archetype: breakdown('hook_archetype'),
      offer_type: breakdown('offer_type'),
      angle: breakdown('angle'),
      angle_universal: breakdown('angle_universal'),
      persona: breakdown('persona'),
      funnel_stage: breakdown('funnel_stage'),
    },
    // Same memoized evaluator as every other consumer (winner-parity invariant).
    mediaQuadrants,
    angleClusters: buildAngleClusters(
      rows,
      replication,
      sizeByAd,
      competitorNames,
      opts.clusterLimit,
      6,
      memoEvaluator
    ),
    exampleAds,
    evaluator: memoEvaluator,
    provenWinners: winnerIds.size,
  };
}

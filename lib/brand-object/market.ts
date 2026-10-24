/**
 * Market distillation — PURE, ZERO LLM. Category priors are aggregated from
 * the EXISTING per-ad LLM labels (ad_labels via library_ads_enriched) over
 * winner-gated competitor ads — never re-labeled. Winner gating reuses the
 * Layer-1 classifier (isWinner × resolveWinProfile × adSurface) WITH cohort
 * thresholds built over the input set — Meta and Google profiles are both
 * cohort-relative now, so skipping the cohort would silently loosen the gate
 * to the floor alone. Replication de-dup: near-identical re-runs of
 * one creative concept (cosine >= DUPLICATE_COSINE within a competitor)
 * collapse to ONE vote whose replicationWeight is the cluster size —
 * "replication = cluster size" doctrine — so an advertiser re-running one ad
 * 10x doesn't count as 10 independent signals but IS stronger evidence.
 */
import { createHash } from 'node:crypto';
import {
  clusterByCosine,
  type ClusterInput,
} from '@/lib/brand-identity/clustering';
import {
  buildCohortThresholds,
  isWinner,
  type ScorableAd,
} from '@/lib/brand-identity/win-score';
import {
  adSurface,
  cohortKey,
  resolveWinProfile,
} from '@/lib/brand-identity/win-profile';
import type { AdFingerprint } from '@/services/ad-library/label-taxonomy';
import { BRAND_OBJECT_CONFIG } from './config';
import { sanitizeExecutionNotes } from './execution-notes';
import { slugifyLabel } from './fact-key';
import type { CandidateFact } from './types';

export interface LabeledEnrichedAd {
  id: string;
  competitorId: string | null;
  platform: string;
  mediaType: string | null;
  isActive: boolean;
  longevityDays: number | null;
  numServedDays: number | null;
  euTotalReach: number | null;
  angle: string | null;
  angleUniversal: string | null;
  hookArchetype: string | null;
  format: string | null;
  offerType: string | null;
  style: string | null;
  aspectRatio: string | null;
  fingerprint: AdFingerprint | null;
  pageName: string | null;
}

export interface AdVector {
  libraryAdId: string;
  vector: number[];
  embeddingModel: string;
}

interface PriorDimension {
  key: string;
  label: string;
  extract: (ad: LabeledEnrichedAd) => string | null | undefined;
  /** Cap on promoted values for this dimension (default topPerDimension). */
  maxValues?: number;
  /** Statement clause override — default `use the '${value}' ${label}`. */
  describe?: (value: string) => string;
}

/** Dimensions promoted into priors. `angle` is the brand's INDUSTRY-SPECIFIC
 * vocabulary (ad_labels.angle, labeled via getAngleVocabulary(industry)) so
 * the playbook speaks the brand's market, not the cross-cohort abstraction;
 * ads labeled before industry classification fall back per-ad to
 * angle_universal so sparse coverage never blanks the dimension. */
const PRIOR_DIMENSIONS: PriorDimension[] = [
  { key: 'angle', label: 'angle', extract: (ad) => ad.angle ?? ad.angleUniversal },
  { key: 'hook_archetype', label: 'hook archetype', extract: (ad) => ad.hookArchetype },
  { key: 'format', label: 'format', extract: (ad) => ad.format },
  { key: 'offer_type', label: 'offer type', extract: (ad) => ad.offerType },
];

/** `false`/`true` tokens for boolean fingerprint dims — the established
 * performance_memory label-rollup stringification. */
function boolToken(value: boolean | undefined): string | null {
  return value === undefined ? null : String(value);
}

/**
 * EXECUTION dimensions (2026-08) — HOW winning ads are staged/shot, promoted
 * from the visual label fingerprint so creative generation can follow the
 * market's execution, not just its strategy. Image-relevant dims only:
 * `text_overlay`/`talking_head` are excluded by the clean-image doctrine (a
 * winning text overlay must never become "add text"), and the video-only
 * fingerprint dims (pacing, duration, voiceover, captions, music) don't
 * apply to statics. `people_present`/`aspect_ratio` promote the MODAL value
 * only — a runner-up boolean row beside the winner is noise, not signal.
 * `aspect_ratio` is observability-only downstream (no prompt directive — a
 * new generation ratio would force renderer version bumps).
 */
const EXECUTION_DIMENSIONS: PriorDimension[] = [
  { key: 'style', label: 'visual style', extract: (ad) => ad.style },
  { key: 'setting', label: 'setting', extract: (ad) => ad.fingerprint?.setting },
  { key: 'tone', label: 'tone', extract: (ad) => ad.fingerprint?.tone },
  {
    key: 'people_present',
    label: 'people presence',
    maxValues: 1,
    extract: (ad) => boolToken(ad.fingerprint?.people_present),
    describe: (value) =>
      value === 'true'
        ? 'show a real person with the product'
        : 'show the product without people',
  },
  {
    key: 'aspect_ratio',
    label: 'aspect ratio',
    maxValues: 1,
    extract: (ad) => ad.aspectRatio,
  },
];

/** Distinct concept-clusters needed before a value becomes a prior. */
const MIN_CLUSTERS_PER_VALUE = 2;

export interface MarketDistillation {
  candidates: CandidateFact[];
  winnerCount: number;
  totalCount: number;
  fingerprint: string;
}

/** Dimensions whose fact evidence carries the representative winner's
 * sanitized execution notes as `quote` (the creative engine lifts them into
 * strategy `executionNotes`). Format + style are the "how it's made" dims. */
const NOTES_EVIDENCE_DIMENSIONS = new Set(['format', 'style']);

export interface DistillMarketOptions {
  /** Competitor/page/advertiser names scrubbed from execution notes at write
   * time (defense-in-depth behind the labeler's brand-name-free prompt). */
  forbiddenNames?: readonly string[];
  /** competitor id → `tracked_competitors.last_synced_at` (ISO). Drives each
   * candidate's `metrics.evidenceAsOf` — the max sync time over the
   * competitors whose winners back that value. Absent/unknown ids simply
   * contribute nothing; a value with no resolvable timestamp omits the field
   * (never null — an unknown age must not read as stale). */
  competitorLastSyncedAt?: Readonly<Record<string, string | null | undefined>>;
}

/** Newest parseable timestamp across the given competitor ids, ISO; null when
 * none resolve. */
function newestSyncedAt(
  competitorIds: Iterable<string>,
  lastSyncedAt: DistillMarketOptions['competitorLastSyncedAt'],
): string | null {
  if (!lastSyncedAt) return null;
  let newest: number | null = null;
  for (const id of competitorIds) {
    const raw = lastSyncedAt[id];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) continue;
    if (newest === null || parsed > newest) newest = parsed;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

export function distillMarketPriors(
  ads: LabeledEnrichedAd[],
  vectors: AdVector[],
  embeddingModel: string,
  options: DistillMarketOptions = {},
): MarketDistillation {
  const scorableOf = (ad: LabeledEnrichedAd): ScorableAd => ({
    is_active: ad.isActive,
    longevity_days: ad.longevityDays ?? 0,
    num_served_days: ad.numServedDays,
    eu_total_reach: ad.euTotalReach,
  });
  const profileOf = (ad: LabeledEnrichedAd) =>
    resolveWinProfile({
      platform: ad.platform,
      // Priors aggregate across the whole competitive set — the per-brand
      // archetype branch doesn't change profile selection today.
      brandType: 'unknown',
      surface: adSurface({
        platform: ad.platform,
        media_type: ad.mediaType,
      }),
    });
  const keyOf = (ad: LabeledEnrichedAd) =>
    cohortKey({
      platform: ad.platform,
      media_type: ad.mediaType,
      competitor_id: ad.competitorId ?? 'unknown',
    });

  // Same cohort = competitor × surface keying as buildWinnerEvaluator, so the
  // priors' winner set reconciles with every dashboard surface.
  const cohortRows = ads.map((ad) => ({ ...scorableOf(ad), __src: ad }));
  const thresholds = buildCohortThresholds(
    cohortRows,
    (row) => keyOf(row.__src),
    (row) => profileOf(row.__src),
  );

  const winners = ads.filter((ad) =>
    isWinner(scorableOf(ad), profileOf(ad), { thresholds, key: keyOf(ad) }),
  );

  // Replication clustering per competitor over winner vectors; ads without a
  // same-model vector stay singleton clusters (they still vote once).
  const inputs: ClusterInput[] = [];
  const winnerIds = new Set(winners.map((ad) => ad.id));
  for (const vec of vectors) {
    if (!winnerIds.has(vec.libraryAdId)) continue;
    const ad = winners.find((w) => w.id === vec.libraryAdId)!;
    inputs.push({
      id: vec.libraryAdId,
      competitorId: ad.competitorId ?? 'unknown',
      vector: vec.vector,
      embeddingModel: vec.embeddingModel,
    });
  }
  const assignments = clusterByCosine(inputs, embeddingModel);

  // Cluster -> representative winner (first seen) + size.
  const clusterOf = (adId: string): string =>
    assignments.get(adId)?.clusterId ?? `solo:${adId}`;
  const clusterSize = new Map<string, number>();
  for (const winner of winners) {
    const cluster = clusterOf(winner.id);
    clusterSize.set(cluster, (clusterSize.get(cluster) ?? 0) + 1);
  }
  const representatives: LabeledEnrichedAd[] = [];
  const seenClusters = new Set<string>();
  for (const winner of winners) {
    const cluster = clusterOf(winner.id);
    if (seenClusters.has(cluster)) continue;
    seenClusters.add(cluster);
    representatives.push(winner);
  }
  const repById = new Map(representatives.map((rep) => [rep.id, rep]));

  const candidates: CandidateFact[] = [];
  for (const dimension of [...PRIOR_DIMENSIONS, ...EXECUTION_DIMENSIONS]) {
    const byValue = new Map<
      string,
      {
        clusters: number;
        replication: number;
        exampleIds: string[];
        competitorIds: Set<string>;
      }
    >();
    for (const rep of representatives) {
      const value = dimension.extract(rep)?.trim();
      if (!value || value === 'other' || value === 'unknown') continue;
      const entry = byValue.get(value) ?? {
        clusters: 0,
        replication: 0,
        exampleIds: [],
        competitorIds: new Set<string>(),
      };
      entry.clusters += 1;
      entry.replication += clusterSize.get(clusterOf(rep.id)) ?? 1;
      if (entry.exampleIds.length < 3) entry.exampleIds.push(rep.id);
      if (rep.competitorId) entry.competitorIds.add(rep.competitorId);
      byValue.set(value, entry);
    }

    const ranked = [...byValue.entries()]
      .filter(([, stats]) => stats.clusters >= MIN_CLUSTERS_PER_VALUE)
      .sort((a, b) => b[1].replication - a[1].replication)
      .slice(0, dimension.maxValues ?? BRAND_OBJECT_CONFIG.market.topPerDimension);

    for (const [value, stats] of ranked) {
      const share =
        representatives.length > 0
          ? Math.round((stats.clusters / representatives.length) * 100)
          : 0;
      const clause =
        dimension.describe?.(value) ?? `use the '${value}' ${dimension.label}`;
      const evidenceAsOf = newestSyncedAt(
        stats.competitorIds,
        options.competitorLastSyncedAt,
      );
      candidates.push({
        section: 'market_prior',
        factKey: `${dimension.key}:${slugifyLabel(value)}`,
        statement:
          `Winning competitor ads in this set ${clause} ` +
          `in ${stats.clusters} of ${representatives.length} ` +
          `distinct creative concepts (${share}%, replication-weighted ${stats.replication}).`,
        details: {
          dimension: dimension.key,
          value,
          share,
          conceptCount: stats.clusters,
          totalConcepts: representatives.length,
        },
        confidence: priorConfidence(stats.clusters),
        source: 'market_distillation',
        // Evidence recomputes on every reconcile pass (kept_live AND
        // confirmed branches), so the sanitized notes stay current where
        // frozen `details` would not.
        evidence: stats.exampleIds.map((id) => {
          const rawNotes = NOTES_EVIDENCE_DIMENSIONS.has(dimension.key)
            ? repById.get(id)?.fingerprint?.execution_notes
            : undefined;
          const quote = rawNotes
            ? sanitizeExecutionNotes(rawNotes, options.forbiddenNames ?? [])
            : null;
          return {
            type: 'ad_label_agg' as const,
            id,
            ...(quote ? { quote } : {}),
          };
        }),
        // Evidence age rides `metrics` (refreshed on every reconcile touch,
        // outside the row content hash) — never `details`, which is frozen
        // and hashed. See lib/brand-object/freshness.ts.
        metrics: {
          winnerCount: stats.clusters,
          replicationWeight: stats.replication,
          ...(evidenceAsOf ? { evidenceAsOf } : {}),
        },
      });
    }
  }

  // Every promoted dimension's inputs must ride this tuple — a relabel that
  // changes only an execution dim (or its notes) must re-derive priors.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        winners
          .map((ad) => [
            ad.id,
            ad.angle,
            ad.angleUniversal,
            ad.hookArchetype,
            ad.format,
            ad.offerType,
            ad.style,
            ad.aspectRatio,
            ad.fingerprint?.setting ?? null,
            ad.fingerprint?.tone ?? null,
            ad.fingerprint?.people_present ?? null,
            ad.fingerprint?.execution_notes ?? null,
          ])
          .sort(),
      ),
    )
    .digest('hex');

  return {
    candidates,
    winnerCount: winners.length,
    totalCount: ads.length,
    fingerprint,
  };
}

/** Deterministic confidence from concept volume — never the founder's 1.0. */
export function priorConfidence(conceptCount: number): number {
  return Math.round(Math.min(0.85, 0.4 + conceptCount * 0.05) * 100) / 100;
}

/**
 * Concept-level performance rollup (Phase 4 item 1) — pure aggregation.
 *
 * Joins published candidates to their realized daily metrics by
 * `publishedAdId === adId` and rolls sums up to each genome dimension value.
 * Deterministic and idempotent: the service recomputes from source-of-truth
 * rows and upserts, so a re-run converges to the same `performance_memory`.
 *
 * Enhanced (attributed) sums follow the ads-manager RPC posture in spirit:
 * they accumulate over reconciled rows only, and `enhancedCoverage` reports
 * the reconciled share so readers never mistake a partial join for a full one.
 */

import { proportionCIsOverlap } from '@/lib/agent/evals/statistics';

import { resolveMetricBasis } from './basis';
import type {
  ContaminationWindow,
  DailyMetricInput,
  DerivedRollupMetrics,
  DimensionRollup,
  FatigueSignal,
  MetricBasis,
  PerformanceDimension,
  PublishedCandidateInput,
  RollupSource,
} from './types';

/** Minimum impressions PER WINDOW HALF before the fatigue split is trusted. */
export const FATIGUE_MIN_IMPRESSIONS_PER_HALF = 500;
/** Recent CTR below this ratio × prior CTR flags decline. */
export const FATIGUE_DECLINE_RATIO = 0.75;

/**
 * Half-life for the time-decayed sums (Workstream C). 14 days is chosen because
 * the median ad lives ~18 days — the scoreboard's memory should roughly match
 * the lifetime of what it judges. A day 14 days old counts half; 28 days, a
 * quarter. Old evidence FADES rather than vanishing, which is what stops a
 * champion coasting on stale glory without ever hard-dropping its history.
 */
export const DECAY_HALF_LIFE_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Weight for one daily row given the moment the rollup was computed.
 * `0.5 ^ (ageDays / halfLifeDays)` — the same formula (and the same clamp) as
 * `lib/brand-object/promotion.ts`'s decayedFrequency, deliberately not a second
 * decay shape in the codebase.
 *
 * PURE: `asOf` is injected, never read from a clock, so a rollup is replayable.
 * Age is clamped at 0, so a row dated in the future (clock skew between the ad
 * platform and us) weighs 1 and can never exceed its own raw value.
 * Unparseable dates weigh 1 — the honest default is "we cannot age this", and
 * silently dropping the row would understate the cell.
 */
export function decayWeight(
  date: string,
  asOf: string,
  halfLifeDays: number = DECAY_HALF_LIFE_DAYS
): number {
  const rowMs = Date.parse(date);
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(rowMs) || !Number.isFinite(asOfMs)) return 1;
  const ageDays = Math.max(0, asOfMs - rowMs) / MS_PER_DAY;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Decayed sums carry fractional precision; 4dp keeps output byte-stable. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** The only contamination scope we know how to scrub surgically. */
const SCOPE_PURCHASES = 'purchases';

/**
 * Apply known contamination windows to one daily row, given the ad's platform.
 * Returns the usable row, or null when the whole row must be dropped.
 *
 * Scope semantics — `metric_scope` is free text in the DB, so:
 *  - 'purchases' → zero the purchase columns ONLY. Spend/impressions/clicks on
 *    a CAPI-replay day are perfectly good CTR evidence; dropping the whole day
 *    would silently delete it.
 *  - anything else → drop the row. We cannot know which columns are safe, and
 *    guessing in favour of keeping poisoned data is the wrong failure mode.
 */
export function scrubContaminatedRow(
  row: DailyMetricInput,
  platform: string,
  windows: readonly ContaminationWindow[]
): DailyMetricInput | null {
  if (windows.length === 0) return row;

  let scrubPurchases = false;
  for (const window of windows) {
    if (window.platform !== platform) continue;
    if (row.date < window.dateStart || row.date > window.dateEnd) continue;
    if (window.metricScope === SCOPE_PURCHASES) {
      scrubPurchases = true;
      continue;
    }
    return null;
  }

  if (!scrubPurchases) return row;
  return {
    ...row,
    purchases: 0,
    purchaseValue: 0,
    // Null, not zero: the verified layer has NOTHING to say about a poisoned
    // day. Zero would read as "attribution ran and found none", which would
    // drag the cell's capture ratio down on evidence that does not exist.
    enhancedPurchases: null,
    enhancedPurchaseValue: null,
  };
}

interface MutableRollup {
  platform: string;
  dimension: PerformanceDimension;
  dimensionValue: string;
  candidateIds: Set<string>;
  adIds: Set<string>;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  enhancedPurchases: number;
  enhancedPurchaseValue: number;
  /** Time-decayed twins of the raw sums (Workstream C). */
  decayedSpend: number;
  decayedImpressions: number;
  decayedClicks: number;
  decayedPurchases: number;
  decayedPurchaseValue: number;
  reconciledRows: number;
  totalRows: number;
  rankScores: number[];
  /** Per-date impression/click accumulation for the fatigue split. */
  daily: Map<string, { impressions: number; clicks: number }>;
}

function dimensionValuesFor(
  candidate: PublishedCandidateInput
): Array<[PerformanceDimension, string]> {
  const genome = candidate.genome ?? {};
  const pairs: Array<[PerformanceDimension, string | undefined]> = [
    ['angle', genome.angle],
    ['persona', genome.persona],
    // Workstream B — the SHARED vocabulary. `angle`/`persona` above are freeform
    // prose and will never collide with a label-side value; these three are
    // closed-taxonomy and are the cells where a generated ad and a labeled
    // imported ad finally accumulate together. Same sanctioned cross-over as
    // `text_overlay` below: they live in LABEL_PERFORMANCE_DIMENSIONS but are
    // valid PerformanceDimensions through the ALL_PERFORMANCE_DIMENSIONS union.
    ['angle_universal', genome.angleUniversal],
    ['persona_universal', genome.personaUniversal],
    ['format', genome.format],
    ['hook_archetype', genome.hookArchetype],
    ['style', genome.style],
    ['aspect_ratio', candidate.aspectRatio],
    // Deterministic overlay outcome (PR 4) → 'true'/'false' ONLY when the
    // genome carries a boolean; absent on historical rows emits no cell,
    // matching the label-side present-only rule. 'text_overlay' lives in
    // LABEL_PERFORMANCE_DIMENSIONS but is a valid PerformanceDimension via the
    // ALL_PERFORMANCE_DIMENSIONS union, so the genome adapter may emit it too.
    ['text_overlay', typeof genome.textOverlay === 'boolean' ? String(genome.textOverlay) : undefined],
  ];
  return pairs.filter((pair): pair is [PerformanceDimension, string] => {
    const value = pair[1]?.trim();
    return typeof value === 'string' && value.length > 0;
  });
}

/**
 * CTR-decline fatigue over a cell's daily rows, split at the IMPRESSION MEDIAN and
 * gated on DISJOINT WILSON BANDS.
 *
 * The split index k (1 ≤ k ≤ n−1; prior = dates[0..k), recent = dates[k..n)) is the
 * one that minimises `|impressions(prior) − impressions(recent)|`; on a tie the
 * EARLIER split wins, so the choice is fully deterministic. `declining` then needs
 * ALL THREE of: both halves ≥ `FATIGUE_MIN_IMPRESSIONS_PER_HALF`, the effect size
 * (`ctrRecent < FATIGUE_DECLINE_RATIO × ctrPrior`), and the uncertainty test — the
 * recent half's 95% Wilson band entirely BELOW the prior half's.
 *
 * Why the IMPRESSION median, not the DATE median (`floor(n/2)`, the pre-2026-09-21
 * rule): a thin partial-day row — a sweep that also sees a few impressions for its
 * own UTC date — MANUFACTURED a decline by re-cutting the halves while adding almost
 * no evidence. On production's 2026-09-09 sweep the census replay wrote 8
 * `creative_fatigue` lessons (all retired 24 h later) ONLY when a thin own-day row
 * was present, and nothing at all without one; the notebook turned on an input
 * nobody could observe. Weighting the cut by VOLUME makes a thin row unable to move
 * it — it lands alone in the recent half, which then fails the impression floor.
 *
 * Why the BAND test: the ratio compares two POINT estimates and asks nothing about
 * how well either is measured. At the ~1% CTRs this engine sees, a half of 500–2,000
 * impressions carries a Wilson band wide enough that a 25% gap is ordinary binomial
 * noise — which is exactly what the arena's placebo world (every effect zeroed,
 * nothing whatsoever to learn) was writing into the notebook: ~11–12 `creative_fatigue`
 * lessons per 60-day run. Measured 2026-09-21, the impression-median cut alone did
 * NOT reduce that number (HEAD and HEAD+the cut were byte-identical at 11/12/12 on
 * seeds 1/2/3): the arena driver writes WHOLE-DAY rows only, so it has no thin row to
 * re-cut, and its placebo fatigue lessons came entirely from unguarded half-vs-half
 * CTR noise. `proportionCIsOverlap` is the repo's ONE significance mechanism
 * (`lib/agent/evals/statistics.ts`, the same call `compareRefreshPair` makes over a
 * before/after window pair) — this is that mechanism applied, never a second test.
 * Full write-up: `tasks/creative-arena-findings.md` §4.2.
 *
 * PURE and deterministic — no clock, no randomness.
 */
function computeFatigue(
  daily: Map<string, { impressions: number; clicks: number }>
): FatigueSignal | null {
  const dates = [...daily.keys()].sort();
  if (dates.length < 2) return null;
  const rows = dates.map((date) => daily.get(date)!);
  const totalImpressions = rows.reduce((sum, row) => sum + row.impressions, 0);

  // Prefix scan for the volume-balanced cut. Strict `<` keeps the EARLIEST best k.
  let bestIndex = 1;
  let bestGap = Number.POSITIVE_INFINITY;
  let priorImpressions = 0;
  for (let index = 1; index < rows.length; index += 1) {
    priorImpressions += rows[index - 1].impressions;
    const gap = Math.abs(priorImpressions - (totalImpressions - priorImpressions));
    if (gap < bestGap) {
      bestGap = gap;
      bestIndex = index;
    }
  }

  const halves = [rows.slice(0, bestIndex), rows.slice(bestIndex)];
  const [prior, recent] = halves.map((half) =>
    half.reduce(
      (acc, row) => {
        acc.impressions += row.impressions;
        acc.clicks += row.clicks;
        return acc;
      },
      { impressions: 0, clicks: 0 }
    )
  );
  if (
    prior.impressions < FATIGUE_MIN_IMPRESSIONS_PER_HALF ||
    recent.impressions < FATIGUE_MIN_IMPRESSIONS_PER_HALF
  ) {
    return null;
  }
  const ctrPrior = prior.clicks / prior.impressions;
  const ctrRecent = recent.clicks / recent.impressions;
  // The floor comes BEFORE the significance test (refresh-outcome's ordering), and
  // the band test is an AND on top of the ratio, never a replacement for it.
  const bands = proportionCIsOverlap(
    { successes: prior.clicks, n: prior.impressions },
    { successes: recent.clicks, n: recent.impressions }
  );
  return {
    ctrPrior,
    ctrRecent,
    declining:
      ctrPrior > 0 &&
      ctrRecent < ctrPrior * FATIGUE_DECLINE_RATIO &&
      // Disjoint bands with the RECENT one below — a one-sided read of the same
      // conservative overlap test, so a well-measured RISE can never read as fatigue.
      bands.bCI.hi < bands.aCI.lo,
  };
}

/**
 * One item to roll up: an ad (adId) contributed by a source entity (itemId) with
 * its (dimension, value) pairs and an optional pre-flight rank score (genome only).
 * `candidateCount` counts distinct contributing itemIds per cell; `adCount` counts
 * distinct adIds — the exact semantics both adapters preserve.
 */
export interface RollupItem {
  adId: string;
  itemId: string;
  platform: string;
  pairs: Array<[PerformanceDimension, string]>;
  /** Genome-only pre-flight rank score; the label side passes none. */
  rankScore?: number | null;
}

/**
 * The shared aggregation core. Joins each item's ad to its daily metric rows and
 * rolls sums up to each (platform, dimension, value) cell, stamping `source`.
 * Deterministic and idempotent — the sort order fixes the output.
 */
export interface RollupOptions {
  /**
   * The instant the rollup is being computed, injected so this module stays
   * PURE (no clock) and every run is replayable. `service.ts` passes the same
   * value it persists as `computed_at`, so any decayed number can be recomputed
   * from the raw metrics and audited.
   */
  asOf: string;
  /**
   * Known-poisoned windows. Applied HERE rather than in the fetcher because
   * scrubbing is platform-scoped and `DailyMetricInput` carries no platform —
   * the item does.
   */
  contamination?: readonly ContaminationWindow[];
  halfLifeDays?: number;
}

export function rollupPairs(
  items: RollupItem[],
  metricRows: DailyMetricInput[],
  source: RollupSource,
  options: RollupOptions
): DimensionRollup[] {
  // An options OBJECT rather than a second optional positional: `asOf` must be
  // required, and an optional one would silently fall back to a clock — exactly
  // the impurity this module forbids.
  const { asOf, contamination = [], halfLifeDays = DECAY_HALF_LIFE_DAYS } = options;
  const metricsByAd = new Map<string, DailyMetricInput[]>();
  for (const row of metricRows) {
    const list = metricsByAd.get(row.adId);
    if (list) list.push(row);
    else metricsByAd.set(row.adId, [row]);
  }

  const cells = new Map<string, MutableRollup>();
  for (const item of items) {
    const rawRows = metricsByAd.get(item.adId) ?? [];
    const rows = rawRows
      .map((row) => scrubContaminatedRow(row, item.platform, contamination))
      .filter((row): row is DailyMetricInput => row !== null);
    for (const [dimension, dimensionValue] of item.pairs) {
      const key = `${item.platform}\0${dimension}\0${dimensionValue}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          platform: item.platform,
          dimension,
          dimensionValue,
          candidateIds: new Set(),
          adIds: new Set(),
          spend: 0,
          impressions: 0,
          clicks: 0,
          purchases: 0,
          purchaseValue: 0,
          enhancedPurchases: 0,
          enhancedPurchaseValue: 0,
          decayedSpend: 0,
          decayedImpressions: 0,
          decayedClicks: 0,
          decayedPurchases: 0,
          decayedPurchaseValue: 0,
          reconciledRows: 0,
          totalRows: 0,
          rankScores: [],
          daily: new Map(),
        };
        cells.set(key, cell);
      }
      cell.candidateIds.add(item.itemId);
      cell.adIds.add(item.adId);
      if (typeof item.rankScore === 'number') cell.rankScores.push(item.rankScore);
      for (const row of rows) {
        cell.spend += row.spend;
        cell.impressions += row.impressions;
        cell.clicks += row.clicks;
        cell.purchases += row.purchases;
        cell.purchaseValue += row.purchaseValue;
        // Decayed twins. `rows` is already contamination-SCRUBBED, so a
        // poisoned day contributes zero here for free — no second guard.
        const weight = decayWeight(row.date, asOf, halfLifeDays);
        cell.decayedSpend += row.spend * weight;
        cell.decayedImpressions += row.impressions * weight;
        cell.decayedClicks += row.clicks * weight;
        cell.decayedPurchases += row.purchases * weight;
        cell.decayedPurchaseValue += row.purchaseValue * weight;
        cell.totalRows += 1;
        if (row.enhancedPurchases !== null || row.enhancedPurchaseValue !== null) {
          cell.enhancedPurchases += row.enhancedPurchases ?? 0;
          cell.enhancedPurchaseValue += row.enhancedPurchaseValue ?? 0;
          cell.reconciledRows += 1;
        }
        const day = cell.daily.get(row.date) ?? { impressions: 0, clicks: 0 };
        day.impressions += row.impressions;
        day.clicks += row.clicks;
        cell.daily.set(row.date, day);
      }
    }
  }

  return [...cells.values()]
    .map((cell): DimensionRollup => {
      const dates = [...cell.daily.keys()].sort();
      const hasEnhanced = cell.reconciledRows > 0;
      const { basis, captureRatio } = resolveMetricBasis({
        platform: cell.platform,
        purchases: cell.purchases,
        enhancedPurchases: hasEnhanced ? cell.enhancedPurchases : null,
      });
      return {
        platform: cell.platform,
        source,
        dimension: cell.dimension,
        dimensionValue: cell.dimensionValue,
        candidateCount: cell.candidateIds.size,
        adCount: cell.adIds.size,
        spend: cell.spend,
        impressions: cell.impressions,
        clicks: cell.clicks,
        purchases: cell.purchases,
        purchaseValue: cell.purchaseValue,
        enhancedPurchases: hasEnhanced ? cell.enhancedPurchases : null,
        enhancedPurchaseValue: hasEnhanced ? cell.enhancedPurchaseValue : null,
        enhancedCoverage: cell.totalRows > 0 ? cell.reconciledRows / cell.totalRows : 0,
        captureRatio,
        basis,
        // Rounded at the boundary so the same inputs always serialize the same
        // bytes; `basis`/`captureRatio` above deliberately stay on the RAW
        // counts (a fractional decayed purchase is not an absolute count and
        // must never move the verified-ruler gate).
        decayedSpend: round4(cell.decayedSpend),
        decayedImpressions: round4(cell.decayedImpressions),
        decayedClicks: round4(cell.decayedClicks),
        decayedPurchases: round4(cell.decayedPurchases),
        decayedPurchaseValue: round4(cell.decayedPurchaseValue),
        meanRankScore:
          cell.rankScores.length > 0
            ? cell.rankScores.reduce((sum, score) => sum + score, 0) / cell.rankScores.length
            : null,
        windowStart: dates[0] ?? null,
        windowEnd: dates[dates.length - 1] ?? null,
        fatigue: computeFatigue(cell.daily),
      };
    })
    .sort(
      (a, b) =>
        a.dimension.localeCompare(b.dimension) || a.dimensionValue.localeCompare(b.dimensionValue)
    );
}

/**
 * Roll published-candidate performance up to (dimension, value) rows — the genome
 * side. Thin adapter over `rollupPairs`: itemId = candidate.id, adId =
 * publishedAdId, rankScore preserved, source 'genome'.
 */
export function rollupByDimension(
  candidates: PublishedCandidateInput[],
  metricRows: DailyMetricInput[],
  options: RollupOptions
): DimensionRollup[] {
  const items: RollupItem[] = candidates.map((candidate) => ({
    adId: candidate.publishedAdId,
    itemId: candidate.id,
    platform: candidate.platform,
    pairs: dimensionValuesFor(candidate),
    rankScore: candidate.rankScore,
  }));
  return rollupPairs(items, metricRows, 'genome', options);
}

/** Read-time derived metrics; base sums stay the stored source of truth. */
export function deriveRollupMetrics(rollup: {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  enhancedPurchaseValue: number | null;
  /**
   * Resolved purchase basis. Optional so historical/partial fixtures keep
   * compiling; absent is treated as 'platform', which is the safe default —
   * an unresolved cell must never claim the verified ruler.
   */
  basis?: MetricBasis;
}): DerivedRollupMetrics {
  // attributedRoas is gated on the RESOLVED BASIS, not on a null check. The
  // reconciler writes explicit zeroes, so `enhancedPurchaseValue !== null` is
  // true for every reconciled cell and used to yield attributedRoas = 0 —
  // which then won basis selection everywhere and collapsed the max-by-ROAS
  // reduce in priors.ts / fact-candidates.ts to "first sorted row wins".
  const onVerifiedBasis = rollup.basis === 'attributed';
  return {
    ctr: rollup.impressions > 0 ? rollup.clicks / rollup.impressions : null,
    cpc: rollup.clicks > 0 ? rollup.spend / rollup.clicks : null,
    roas: rollup.spend > 0 ? rollup.purchaseValue / rollup.spend : null,
    cpa: rollup.purchases > 0 ? rollup.spend / rollup.purchases : null,
    attributedRoas:
      onVerifiedBasis && rollup.spend > 0 && rollup.enhancedPurchaseValue !== null
        ? rollup.enhancedPurchaseValue / rollup.spend
        : null,
  };
}

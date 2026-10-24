import type { EnrichedAdRow } from './types';

/**
 * Analyst's Desk pure computation — Creative DNA, launch cadence, and a survival
 * (right-censored longevity) curve for a single competitor's ad rows.
 *
 * Everything here is deterministic: `now` is injected so cadence/survival never
 * read the wall clock, and all grouping/ranking is stable-sorted. No DB access,
 * no copy that implies a scrape cadence (bins are a time axis of history, not a
 * freshness claim — the ad-library rescrape runs ~2-weekly).
 */

/** 12 seven-day bins = the trailing ~quarter of launch/kill history. */
export const CADENCE_WEEKS = 12;
/** Survival curve horizon, in days. */
export const SURVIVAL_MAX_DAYS = 90;
/** Survival curve sampling step, in days. */
export const SURVIVAL_STEP_DAYS = 5;
/** A cadence bin is a "batch" bin when it carries at least this many launches. */
const BATCH_MIN_LAUNCHES = 3;
/** Median longevity needs at least this many ads to be meaningful. */
const MEDIAN_MIN_ADS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface DnaFormatSlice {
  value: string;
  count: number;
  /** Share of the format-labeled subset (slices sum to 1 when any labeled). */
  share: number;
}

export interface CadenceBin {
  /** ISO timestamp of the bin's start (inclusive); bins run oldest→newest. */
  startIso: string;
  launches: number;
  kills: number;
}

export interface SurvivalPoint {
  day: number;
  /** Share of observable ads still alive at `day` (right-censored). */
  aliveShare: number;
}

export type CadenceNoteCopy =
  | { code: 'batches' }
  | { code: 'batchesWithKills'; trailDays: number };

export interface DeskAnalysis {
  dna: {
    formatMix: DnaFormatSlice[];
    topHook: { value: string; share: number } | null;
    topAngle: { value: string; share: number } | null;
  };
  cadence: {
    bins: CadenceBin[];
    note: string | null;
    /**
     * Structured twin of `note` (i18n): the screen renders it through the
     * catalog in non-English locales; `note` stays the English source of truth.
     */
    noteCopy: CadenceNoteCopy | null;
  };
  survival: {
    points: SurvivalPoint[];
    medianDays: number | null;
  };
}

/**
 * Most-common non-null value of `key`, as `{ value, share }` over the subset of
 * rows that carry that label (null when nothing is labeled). Ties break on the
 * value string so the result is stable.
 */
function topLabel(
  rows: EnrichedAdRow[],
  key: 'hook_archetype' | 'angle'
): { value: string; share: number } | null {
  const counts = new Map<string, number>();
  let labeled = 0;
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    labeled += 1;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (labeled === 0) return null;

  let best: { value: string; count: number } | null = null;
  for (const [value, count] of counts) {
    if (
      !best ||
      count > best.count ||
      (count === best.count && value < best.value)
    ) {
      best = { value, count };
    }
  }
  return best ? { value: best.value, share: best.count / labeled } : null;
}

/**
 * Format mix over the format-labeled subset, descending by share. Shares sum to
 * 1 across the returned slices (ads with a null `format` are excluded, not
 * counted as a slice). Ties break on the format string for stability.
 */
function buildFormatMix(rows: EnrichedAdRow[]): DnaFormatSlice[] {
  const counts = new Map<string, number>();
  let labeled = 0;
  for (const row of rows) {
    if (!row.format) continue;
    labeled += 1;
    counts.set(row.format, (counts.get(row.format) ?? 0) + 1);
  }
  if (labeled === 0) return [];

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, share: count / labeled }))
    .sort((a, b) => b.share - a.share || (a.value < b.value ? -1 : 1));
}

/**
 * Twelve seven-day bins ending at `now` (oldest→newest). Launches are
 * `delivery_start` (the PLATFORM's launch date, populated by both the Meta and
 * Google normalizers and refreshed on upsert) falling in the bin; kills are
 * `delivery_stop` in the bin. Ads whose timestamps fall outside the trailing
 * window simply aren't counted.
 *
 * NEVER bin launches by `first_seen_at`: that column is when Adcero first
 * INGESTED the ad (a Postgres insert default, untouched on re-sync). For a
 * newly tracked competitor every historical ad shares one `first_seen_at` ≈
 * the first sync, which would render one giant fake "batch" bin at tracking
 * start and misfire the batch-note heuristic (cold-start artifact).
 */
function buildCadenceBins(rows: EnrichedAdRow[], now: Date): CadenceBin[] {
  const nowMs = now.getTime();
  const windowStart = nowMs - CADENCE_WEEKS * WEEK_MS;

  const bins: CadenceBin[] = Array.from({ length: CADENCE_WEEKS }, (_, i) => ({
    startIso: new Date(windowStart + i * WEEK_MS).toISOString(),
    launches: 0,
    kills: 0,
  }));

  const binIndexFor = (ms: number): number | null => {
    if (ms < windowStart || ms >= nowMs) return null;
    const index = Math.floor((ms - windowStart) / WEEK_MS);
    // Clamp defensively against float edge cases at the boundary.
    return index >= 0 && index < CADENCE_WEEKS ? index : null;
  };

  for (const row of rows) {
    // Platform launch date — NOT first_seen_at (Adcero ingestion time).
    const launchMs = new Date(row.delivery_start).getTime();
    if (Number.isFinite(launchMs)) {
      const idx = binIndexFor(launchMs);
      if (idx !== null) bins[idx].launches += 1;
    }
    if (row.delivery_stop) {
      const killMs = new Date(row.delivery_stop).getTime();
      if (Number.isFinite(killMs)) {
        const idx = binIndexFor(killMs);
        if (idx !== null) bins[idx].kills += 1;
      }
    }
  }
  return bins;
}

/**
 * Deterministic cadence note, emitted ONLY when the launch pattern is clearly
 * batched: at least two "batch" bins (>= BATCH_MIN_LAUNCHES launches) separated
 * by at least one quieter bin. When ads have been killed, the note reports how
 * long kills trail launches (median longevity of killed ads). Otherwise null.
 */
function buildCadenceNote(
  bins: CadenceBin[],
  rows: EnrichedAdRow[]
): { text: string; copy: CadenceNoteCopy } | null {
  const batchBinIndexes = bins
    .map((bin, index) => ({ index, launches: bin.launches }))
    .filter((b) => b.launches >= BATCH_MIN_LAUNCHES)
    .map((b) => b.index);

  if (batchBinIndexes.length < 2) return null;

  // "Separated by quiet bins" — two batch bins with a gap of >= 1 bin between.
  let separated = false;
  for (let i = 1; i < batchBinIndexes.length; i += 1) {
    if (batchBinIndexes[i] - batchBinIndexes[i - 1] >= 2) {
      separated = true;
      break;
    }
  }
  if (!separated) return null;

  const killedLongevities = rows
    .filter((row) => row.delivery_stop)
    .map((row) => row.longevity_days)
    .filter((days) => Number.isFinite(days))
    .sort((a, b) => a - b);

  if (killedLongevities.length === 0) {
    return { text: 'Launches arrive in batches.', copy: { code: 'batches' } };
  }
  const trailDays = Math.round(median(killedLongevities));
  return {
    text: `Launches arrive in batches; kills trail by ~${trailDays} days.`,
    copy: { code: 'batchesWithKills', trailDays },
  };
}

/** Median of a pre-sorted ascending numeric array. Caller guarantees length>0. */
function median(sortedAsc: number[]): number {
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 0
    ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2
    : sortedAsc[mid];
}

/**
 * Right-censored survival curve. For each sampled `day` in [0, SURVIVAL_MAX_DAYS]:
 *
 *   denominator = ads OBSERVABLE at that age. A killed ad (has `delivery_stop`)
 *     is always observable — we watched its whole life. A still-active ad is
 *     observable only through its CURRENT age (`longevity_days`): once `day`
 *     exceeds it, the ad is right-censored (unknown future) and is EXCLUDED
 *     from the denominator, so a young active ad can never deflate a late-day
 *     alive share.
 *   numerator = observable ads with `longevity_days >= day` (still alive at
 *     that age). An ad killed at day d therefore counts dead for every day > d.
 *
 * aliveShare = numerator / denominator (0 when nothing is observable).
 */
function buildSurvivalPoints(rows: EnrichedAdRow[]): SurvivalPoint[] {
  const points: SurvivalPoint[] = [];
  for (let day = 0; day <= SURVIVAL_MAX_DAYS; day += SURVIVAL_STEP_DAYS) {
    let denominator = 0;
    let alive = 0;
    for (const row of rows) {
      const killed = Boolean(row.delivery_stop);
      const age = row.longevity_days;
      // Active ad younger than `day` is censored — not yet observed to this age.
      const observable = killed || age >= day;
      if (!observable) continue;
      denominator += 1;
      if (age >= day) alive += 1;
    }
    points.push({
      day,
      aliveShare: denominator > 0 ? alive / denominator : 0,
    });
  }
  return points;
}

/**
 * Time bases: cadence launches bin on `delivery_start` (platform launch date);
 * kills on `delivery_stop`. DNA reads only the label columns
 * (`format`/`hook_archetype`/`angle`); survival reads only
 * `longevity_days`/`delivery_stop`. `first_seen_at` (ingestion time) is
 * intentionally unused everywhere in this module — see buildCadenceBins.
 */
export function buildDeskAnalysis(
  rows: EnrichedAdRow[],
  opts: { now: Date }
): DeskAnalysis {
  const cadenceBins = buildCadenceBins(rows, opts.now);
  const cadenceNote = buildCadenceNote(cadenceBins, rows);

  const longevities = rows
    .map((row) => row.longevity_days)
    .filter((days) => Number.isFinite(days))
    .sort((a, b) => a - b);

  return {
    dna: {
      formatMix: buildFormatMix(rows),
      topHook: topLabel(rows, 'hook_archetype'),
      topAngle: topLabel(rows, 'angle'),
    },
    cadence: {
      bins: cadenceBins,
      note: cadenceNote?.text ?? null,
      noteCopy: cadenceNote?.copy ?? null,
    },
    survival: {
      points: buildSurvivalPoints(rows),
      medianDays:
        longevities.length >= MEDIAN_MIN_ADS ? median(longevities) : null,
    },
  };
}

/**
 * Pure aggregation for the Brand Identity per-media-type winners-vs-rest quadrants.
 * For IMAGE creatives and VIDEO creatives separately, runs the same winners-vs-all
 * over-index analysis as the main panel but over the VISUAL dimensions of the
 * creative fingerprint (migration 0090) — style / aspect_ratio / tone / setting /
 * pacing / duration_bucket.
 *
 * No DB, no React — same conventions as dashboard.ts; the API route serializes the
 * carried rows. The generalized over-index core (`buildOverIndexBy`) is extracted
 * here so dashboard.ts's `buildOverIndex` delegates to it: one implementation of the
 * winners-vs-all math for both the LLM-label dimensions and the visual dimensions.
 *
 * Import-cycle note: `WinnerEvaluator` lives in dashboard.ts, which value-imports
 * from this module. It is imported here TYPE-ONLY (erased at runtime), so there is
 * no runtime cycle.
 */

import { mean, median } from './math';
import type {
  AnalysisDimension,
  DimensionOverIndex,
  EnrichedAdRow,
  MediaQuadrantDimension,
  MediaQuadrantGroup,
  MediaQuadrants,
  OverIndexRow,
} from './types';
import { IMAGE_QUADRANT_DIMENSIONS, VIDEO_QUADRANT_DIMENSIONS } from './types';
import type { WinnerEvaluator } from './dashboard';
import {
  DURATION_BUCKETS,
  PACINGS,
  SETTINGS,
  TONES,
} from '@/services/ad-library/label-taxonomy';

/* ── generalized over-index (winners vs the rest) ───────────────────────── */

/**
 * The winners-vs-all over-index core, parameterized by a value extractor and the
 * winner evaluator. Byte-equivalent math to the legacy `buildOverIndex` body:
 * labeled filter (value !== null), memoized winner map, per-value tallies, lift =
 * winnerShare / allShare, medianLongevity, activeShare, avgReach (mean over the
 * members that report EU reach), and the identical sort (lift desc → winnerShare
 * desc → label asc).
 *
 * `scoreByAdId` (win-score per ad, same signal that ranks the winners grid) picks
 * each label's `topAdId` — the "top result" the matrix opens on a label click.
 * Tie-break: score desc → longevity desc → id asc, so it is deterministic.
 * The same map feeds each row's `medianWinScore` (full label set) and the
 * dimension's pooled `medianWinScore` (every labeled ad) — the matrix y-axis.
 */
/**
 * Max example ads carried per over-index row. The matrix opens this whole list
 * for arrow-through navigation; the cap bounds the serialized `exampleAds` pool
 * so a single high-volume tactic can't bloat the dashboard payload. 50 is well
 * past what a user scrolls, and the list is win-score-ranked so the best show first.
 */
export const MAX_TACTIC_EXAMPLES = 50;

export function buildOverIndexBy(
  rows: EnrichedAdRow[],
  dimension: AnalysisDimension,
  valueOf: (_row: EnrichedAdRow) => string | null,
  evaluator: WinnerEvaluator,
  scoreByAdId: Map<string, number> = new Map()
): DimensionOverIndex {
  const labeled = rows.filter((r) => valueOf(r) !== null);
  const totalLabeled = labeled.length;
  const winnerById = new Map(labeled.map((r) => [r.id, evaluator.isWinner(r)]));
  const totalWinners = labeled.filter((r) => winnerById.get(r.id)).length;

  interface RankedAd {
    id: string;
    score: number;
    longevity: number;
  }
  interface Tally {
    total: number;
    winner: number;
    active: number;
    longevities: number[];
    /** Only members that report EU reach — a null reach is absent, not a zero. */
    reaches: number[];
    ads: RankedAd[];
  }
  /** a outranks b when score → longevity → id asc. */
  const compareAds = (a: RankedAd, b: RankedAd): number =>
    b.score - a.score || b.longevity - a.longevity || (a.id < b.id ? -1 : 1);

  const tallies = new Map<string, Tally>();
  for (const row of labeled) {
    const value = valueOf(row)!;
    const entry =
      tallies.get(value) ??
      { total: 0, winner: 0, active: 0, longevities: [], reaches: [], ads: [] };
    entry.total += 1;
    if (winnerById.get(row.id)) entry.winner += 1;
    if (row.is_active) entry.active += 1;
    entry.longevities.push(row.longevity_days);
    if (row.eu_total_reach != null) entry.reaches.push(row.eu_total_reach);
    entry.ads.push({
      id: row.id,
      score: scoreByAdId.get(row.id) ?? 0,
      longevity: row.longevity_days,
    });
    tallies.set(value, entry);
  }

  const out: OverIndexRow[] = [];
  for (const [
    label,
    { total, winner, active, longevities, reaches, ads },
  ] of tallies) {
    const allShare = totalLabeled ? total / totalLabeled : 0;
    const winnerShare = totalWinners ? winner / totalWinners : 0;
    // Full win-score-ranked example list (the matrix arrows through it), capped
    // so a mega-tactic can't unbound the serialized `exampleAds` pool.
    const exampleAdIds = ads
      .sort(compareAds)
      .slice(0, MAX_TACTIC_EXAMPLES)
      .map((a) => a.id);
    // Over the full label set (before the example cap), so volume is honest.
    const medianWinScore = median(ads.map((a) => a.score));
    out.push({
      label,
      winnerShare,
      allShare,
      lift: allShare > 0 ? winnerShare / allShare : 0,
      winnerCount: winner,
      totalCount: total,
      medianLongevity: median(longevities),
      activeShare: total ? active / total : 0,
      avgReach: mean(reaches),
      topAdId: exampleAdIds[0] ?? null,
      exampleAdIds,
      medianWinScore,
    });
  }
  out.sort(
    (a, b) =>
      b.lift - a.lift ||
      b.winnerShare - a.winnerShare ||
      (a.label < b.label ? -1 : 1)
  );
  return {
    dimension,
    rows: out,
    medianWinScore: median(labeled.map((r) => scoreByAdId.get(r.id) ?? 0)),
  };
}

/* ── media bucketing + visual value extraction ──────────────────────────── */

/**
 * The media bucket an ad belongs to: 'image'/'carousel' → image; 'video' → video;
 * everything else ('text', 'unknown', null) → null (excluded from both buckets).
 */
export function mediaBucketOf(mediaType: string | null): 'image' | 'video' | null {
  if (mediaType === 'image' || mediaType === 'carousel') return 'image';
  if (mediaType === 'video') return 'video';
  return null;
}

// Membership sets built once at module scope — only values present in the label
// taxonomy count; anything else in the (untyped jsonb) fingerprint is ignored.
const TONE_SET: ReadonlySet<string> = new Set(TONES);
const SETTING_SET: ReadonlySet<string> = new Set(SETTINGS);
const PACING_SET: ReadonlySet<string> = new Set(PACINGS);
const DURATION_SET: ReadonlySet<string> = new Set(DURATION_BUCKETS);

/** Reads a fingerprint attribute, accepting ONLY taxonomy-valid string values. */
function fingerprintValue(
  fingerprint: Record<string, unknown> | null,
  key: string,
  allowed: ReadonlySet<string>
): string | null {
  if (!fingerprint) return null;
  const raw = fingerprint[key];
  return typeof raw === 'string' && allowed.has(raw) ? raw : null;
}

/**
 * The grouping value for a media dimension. style / aspect_ratio are their own
 * (already-validated) enriched-row columns; tone / setting / pacing /
 * duration_bucket read from the fingerprint jsonb, taxonomy-validated.
 */
function mediaDimensionValue(
  row: EnrichedAdRow,
  dimension: MediaQuadrantDimension
): string | null {
  switch (dimension) {
    case 'style':
      return row.style;
    case 'aspect_ratio':
      return row.aspect_ratio;
    case 'tone':
      return fingerprintValue(row.fingerprint, 'tone', TONE_SET);
    case 'setting':
      return fingerprintValue(row.fingerprint, 'setting', SETTING_SET);
    case 'pacing':
      return fingerprintValue(row.fingerprint, 'pacing', PACING_SET);
    case 'duration_bucket':
      return fingerprintValue(row.fingerprint, 'duration_bucket', DURATION_SET);
  }
}

/* ── per-media quadrants ─────────────────────────────────────────────────── */

function buildMediaGroup(
  rows: EnrichedAdRow[],
  dimensions: readonly MediaQuadrantDimension[],
  evaluator: WinnerEvaluator,
  scoreByAdId: Map<string, number>
): MediaQuadrantGroup {
  return {
    totalAds: rows.length,
    visuallyLabeledAds: rows.filter((r) => r.style !== null).length,
    overIndex: dimensions.map((dim) =>
      buildOverIndexBy(
        rows,
        dim,
        (row) => mediaDimensionValue(row, dim),
        evaluator,
        scoreByAdId
      )
    ),
  };
}

/**
 * Buckets the rows by media type and produces, per bucket, the visual over-index
 * across that bucket's dimension list. An empty bucket yields totalAds 0 and
 * overIndex entries with empty rows arrays (buildOverIndexBy already does that).
 * The evaluator MUST be the dashboard's memoized evaluator so winner numbers
 * reconcile with every other surface (the CLAUDE.md winner-parity invariant).
 */
export function buildMediaQuadrants(
  rows: EnrichedAdRow[],
  evaluator: WinnerEvaluator,
  scoreByAdId: Map<string, number> = new Map()
): MediaQuadrants {
  const image: EnrichedAdRow[] = [];
  const video: EnrichedAdRow[] = [];
  for (const row of rows) {
    const bucket = mediaBucketOf(row.media_type);
    if (bucket === 'image') image.push(row);
    else if (bucket === 'video') video.push(row);
  }
  return {
    image: buildMediaGroup(image, IMAGE_QUADRANT_DIMENSIONS, evaluator, scoreByAdId),
    video: buildMediaGroup(video, VIDEO_QUADRANT_DIMENSIONS, evaluator, scoreByAdId),
  };
}

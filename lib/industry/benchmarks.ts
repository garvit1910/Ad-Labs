/**
 * Industry Knowledge Layer — pure aggregation (Phase 6).
 *
 * `aggregateBenchmarks` folds every participating org's per-(industry, platform,
 * source, dimension, value) performance_memory row into ANONYMIZED vertical
 * cells: it SUMS the raw counts and counts DISTINCT contributing orgs
 * (`merchantCount`). No org id ever survives into the output — the cell key has
 * no org axis, so a single merchant's numbers can never be reconstructed
 * (anonymity by construction, locked decision #3).
 *
 * `meetsDensity` is the structural density gate: a cell qualifies to be SERVED
 * only when it aggregates at least `minMerchants` distinct orgs AND
 * `minImpressions` total impressions. That is the enforcement point that keeps
 * the product from making cross-tenant promises before real density exists.
 *
 * PURE — no DB, no clock. `service.ts` reads/writes; this module only folds.
 *
 * CONTROLLED-VOCABULARY GATE (privacy): genome `angle`/`persona` (and
 * `hook_archetype`) are freeform strings on briefs — a merchant's angle can be
 * brand-identifying prose ("Beat CompetitorX on price by 30%"). "Concept-level"
 * aggregation is only anonymous when the dimension VALUE is a shared vocabulary
 * token, so `aggregateBenchmarks` folds ONLY rows whose value passes
 * `isCrossTenantSafeRow`: angles/personas against the brand-identity taxonomy
 * (`isKnownAngle`/`isKnownPersona`), hook archetypes + styles against their
 * closed enums, aspect ratios against the `W:H` shape. Unknown dimensions FAIL
 * CLOSED. Freeform prose never reaches `industry_benchmarks` — it stays a
 * per-tenant `performance_memory` value only.
 */
import {
  isKnownAngle,
  isKnownPersona,
} from '@/lib/brand-identity/industry-taxonomy';
import { HOOK_ARCHETYPES, VISUAL_STYLES } from '@/services/ad-library/label-taxonomy';

/** One participating-org performance_memory row (camelCase input to the fold). */
export interface BenchmarkInputRow {
  organizationId: string;
  industryKey: string;
  platform: string;
  source: string;
  dimension: string;
  dimensionValue: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  /** ISO date or null (min/max folded into the cell window). */
  windowStart: string | null;
  windowEnd: string | null;
}

/** Density floors — resolved from env with documented defaults (see resolveThresholds). */
export interface BenchmarkThresholds {
  minMerchants: number;
  minImpressions: number;
}

/** One aggregated vertical cell — the `industry_benchmarks` row shape (sums only). */
export interface BenchmarkCell {
  industryKey: string;
  platform: string;
  source: string;
  dimension: string;
  dimensionValue: string;
  merchantCount: number;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  meetsDensity: boolean;
  windowStart: string | null;
  windowEnd: string | null;
}

export const INDUSTRY_BENCH_MIN_MERCHANTS_DEFAULT = 3;
export const INDUSTRY_BENCH_MIN_IMPRESSIONS_DEFAULT = 5000;

/** Positive-integer env reader with a documented default (fail to the default, never NaN). */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Resolve density floors from env (`INDUSTRY_BENCH_MIN_MERCHANTS` default 3,
 * `INDUSTRY_BENCH_MIN_IMPRESSIONS` default 5000). Named + overridable so the gate
 * can be tuned without a deploy; conservative defaults so the product never
 * over-promises on a thin vertical.
 */
export function resolveThresholds(): BenchmarkThresholds {
  return {
    minMerchants: readPositiveIntEnv('INDUSTRY_BENCH_MIN_MERCHANTS', INDUSTRY_BENCH_MIN_MERCHANTS_DEFAULT),
    minImpressions: readPositiveIntEnv('INDUSTRY_BENCH_MIN_IMPRESSIONS', INDUSTRY_BENCH_MIN_IMPRESSIONS_DEFAULT),
  };
}

const KEY_SEP = '\u0000';
function cellKey(r: BenchmarkInputRow): string {
  return [r.industryKey, r.platform, r.source, r.dimension, r.dimensionValue].join(KEY_SEP);
}

const HOOK_ARCHETYPE_SET: ReadonlySet<string> = new Set<string>(HOOK_ARCHETYPES);
const VISUAL_STYLE_SET: ReadonlySet<string> = new Set<string>(VISUAL_STYLES);
/** `W:H` ratio tokens (e.g. `4:5`, `1.91:1`) or the copy-candidate marker `n/a`. */
const ASPECT_RATIO_SHAPE = /^\d+(\.\d+)?:\d+(\.\d+)?$/;

/**
 * The cross-tenant privacy gate: a row may feed `industry_benchmarks` ONLY when
 * its dimension value is a shared controlled-vocabulary token — never freeform
 * merchant prose (which can carry brand names, competitor names, or audience
 * descriptions that identify a participant even inside an aggregate). Genome
 * `angle`/`persona` are freeform strings on briefs, so they pass only when they
 * match the brand-identity taxonomy; hook archetypes and styles check their
 * closed enums; aspect ratios check the `W:H` shape. Unknown dimensions FAIL
 * CLOSED.
 */
export function isCrossTenantSafeRow(dimension: string, dimensionValue: string): boolean {
  if (!dimensionValue) return false;
  switch (dimension) {
    case 'angle':
      return isKnownAngle(dimensionValue);
    case 'persona':
      return isKnownPersona(dimensionValue);
    case 'hook_archetype':
      return HOOK_ARCHETYPE_SET.has(dimensionValue);
    case 'style':
      return VISUAL_STYLE_SET.has(dimensionValue);
    case 'aspect_ratio':
      return dimensionValue === 'n/a' || ASPECT_RATIO_SHAPE.test(dimensionValue);
    default:
      return false;
  }
}

/** min of two nullable ISO dates (nulls ignored). */
function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
/** max of two nullable ISO dates (nulls ignored). */
function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

interface Accumulator {
  industryKey: string;
  platform: string;
  source: string;
  dimension: string;
  dimensionValue: string;
  orgs: Set<string>;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  windowStart: string | null;
  windowEnd: string | null;
}

/**
 * Fold participating-org rows into anonymized density-gated vertical cells.
 * `merchantCount` = distinct contributing orgs (Set — a single org's multiple
 * rows for the same cell count ONCE). `meetsDensity` = both floors cleared.
 */
export function aggregateBenchmarks(
  rows: BenchmarkInputRow[],
  thresholds: BenchmarkThresholds,
): BenchmarkCell[] {
  const acc = new Map<string, Accumulator>();

  for (const r of rows) {
    // A cell is meaningless without a dimension value; skip degenerate rows.
    if (!r.industryKey || !r.dimension || !r.dimensionValue) continue;
    // Privacy gate: only controlled-vocabulary values cross the tenant boundary.
    if (!isCrossTenantSafeRow(r.dimension, r.dimensionValue)) continue;
    const key = cellKey(r);
    let a = acc.get(key);
    if (!a) {
      a = {
        industryKey: r.industryKey,
        platform: r.platform,
        source: r.source,
        dimension: r.dimension,
        dimensionValue: r.dimensionValue,
        orgs: new Set<string>(),
        spend: 0,
        impressions: 0,
        clicks: 0,
        purchases: 0,
        purchaseValue: 0,
        windowStart: null,
        windowEnd: null,
      };
      acc.set(key, a);
    }
    a.orgs.add(r.organizationId);
    a.spend += r.spend || 0;
    a.impressions += r.impressions || 0;
    a.clicks += r.clicks || 0;
    a.purchases += r.purchases || 0;
    a.purchaseValue += r.purchaseValue || 0;
    a.windowStart = minDate(a.windowStart, r.windowStart);
    a.windowEnd = maxDate(a.windowEnd, r.windowEnd);
  }

  const cells: BenchmarkCell[] = [];
  for (const a of acc.values()) {
    const merchantCount = a.orgs.size;
    const meetsDensity =
      merchantCount >= thresholds.minMerchants && a.impressions >= thresholds.minImpressions;
    cells.push({
      industryKey: a.industryKey,
      platform: a.platform,
      source: a.source,
      dimension: a.dimension,
      dimensionValue: a.dimensionValue,
      merchantCount,
      spend: a.spend,
      impressions: a.impressions,
      clicks: a.clicks,
      purchases: a.purchases,
      purchaseValue: a.purchaseValue,
      meetsDensity,
      windowStart: a.windowStart,
      windowEnd: a.windowEnd,
    });
  }
  return cells;
}

/** Read-time derived metrics from a cell's sums (never stored — mirrors the loop). */
export interface DerivedBenchmarkMetrics {
  ctr: number | null;
  roas: number | null;
  cpa: number | null;
}

export function deriveBenchmarkMetrics(cell: {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
}): DerivedBenchmarkMetrics {
  return {
    ctr: cell.impressions > 0 ? cell.clicks / cell.impressions : null,
    roas: cell.spend > 0 ? cell.purchaseValue / cell.spend : null,
    cpa: cell.purchases > 0 ? cell.spend / cell.purchases : null,
  };
}

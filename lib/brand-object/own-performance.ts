/**
 * "What's working for you" — the org's OWN ad performance per creative label,
 * spend-weighted, as a pure render model.
 *
 * Chapter 04 shows what wins in the MARKET (competitor replication weight);
 * this chapter is the mirror on the brand's own ads: per label dimension
 * (hook → angle → format → offer → persona → funnel stage, the order an ad is
 * BUILT), how spend splits across the label values and what each value
 * returned. Same doctrine as the rest of the report — ZERO LLM, every number
 * is arithmetic over the rows handed in, every headline is a template chosen
 * by threshold, and a tag value is only ever humanized, never reworded.
 *
 * Inputs arrive ALREADY in the org display currency (the loader converts the
 * money BASES per account before aggregating); this module only sums bases and
 * recomputes ratios from the sums — it never converts or averages a ratio.
 * Returns are the PLATFORM ruler (`purchase_value ÷ spend`), so `basis` says so.
 *
 * PURE, zero IO, client-safe — and deliberately free of `lib/creative-engine`
 * imports (the dependency runs creative-engine → brand-object, never back).
 */
import { humanizeTagValue } from './insights';
import { normalizeAngleToken } from './own-angles';
import { formatPerformanceMoney, formatRoas, formatSharePct } from './own-performance-format';

/** A ratio is only stated once a value has at least this many purchases. */
export const MIN_PURCHASES_FOR_RETURN = 3;
/** "Winning combination" gates: ads, purchases, and share of labeled spend. */
export const COMBINATION_MIN_ADS = 2;
export const COMBINATION_MIN_PURCHASES = 3;
export const COMBINATION_MIN_SPEND_SHARE_PCT = 5;
export const MAX_COMBINATIONS = 5;
/** The windows the route accepts. */
export const OWN_PERFORMANCE_WINDOWS = [7, 30, 90] as const;
export type OwnPerformanceWindow = (typeof OWN_PERFORMANCE_WINDOWS)[number];
export const DEFAULT_OWN_PERFORMANCE_WINDOW: OwnPerformanceWindow = 30;

/** BUILD order — the order an ad is made in, not table order. */
export const OWN_PERFORMANCE_DIMENSIONS = [
  { key: 'hook_archetype', label: 'Hook', noun: 'hook' },
  { key: 'angle', label: 'Angle', noun: 'angle' },
  { key: 'format', label: 'Format', noun: 'format' },
  { key: 'offer_type', label: 'Offer', noun: 'offer' },
  { key: 'persona', label: 'Persona', noun: 'persona' },
  { key: 'funnel_stage', label: 'Funnel stage', noun: 'funnel stage' },
] as const;
export type OwnPerformanceDimensionKey =
  (typeof OWN_PERFORMANCE_DIMENSIONS)[number]['key'];

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export interface OwnPerformanceLabels {
  angle: string | null;
  angleUniversal: string | null;
  hookArchetype: string | null;
  format: string | null;
  persona: string | null;
  funnelStage: string | null;
  offerType: string | null;
}

/** One labeled ad, summed over the window, money in the display currency. */
export interface OwnPerformanceInputRow {
  adId: string;
  platform: string;
  labels: OwnPerformanceLabels;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
}

export interface OwnPerformanceCoverage {
  /** Labeled ads with spend in the window. */
  labeledAdsWithSpend: number;
  /** Every org ad with spend in the window — the coverage denominator. */
  totalAdsWithSpend: number;
  labeledSpend: number;
  totalSpend: number;
}

/** Own ads have no brand: >1 self brand means one pooled, org-wide read. */
export interface OwnPerformanceScope {
  pooled: boolean;
  brandCount: number;
}

export interface OwnPerformanceInput {
  rows: OwnPerformanceInputRow[];
  windowDays: number;
  /** Inclusive ISO dates (YYYY-MM-DD) of the window. */
  from: string;
  to: string;
  /** The display currency every money input is already in. */
  currency: string;
  coverage: OwnPerformanceCoverage;
  scope: OwnPerformanceScope;
  /** Factual note when some spend could not be converted and was left out. */
  currencyNote?: string | null;
  /** True when the metrics read stopped at its page bound. */
  truncated?: boolean;
  /** Synthetic demo model (pinned demo orgs only). */
  demo?: boolean;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

export interface OwnPerformanceTotals {
  adCount: number;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  /** purchaseValue ÷ spend; null under `MIN_PURCHASES_FOR_RETURN`. */
  roas: number | null;
  /** spend ÷ purchases; null under `MIN_PURCHASES_FOR_RETURN`. */
  cpa: number | null;
  /** clicks ÷ impressions × 100; null with no impressions. */
  ctr: number | null;
}

export interface OwnPerformanceRow extends OwnPerformanceTotals {
  /** Normalized tag token (snake_case) — humanize it for display. */
  value: string;
  /** spend ÷ the dimension's spend × 100 — exact, so shares sum to 100. */
  spendSharePct: number;
}

export interface OwnPerformanceDimension {
  dimension: OwnPerformanceDimensionKey;
  label: string;
  noun: string;
  /** Spend desc, then ad count desc, then value asc. */
  rows: OwnPerformanceRow[];
  /** Ads carrying this dimension (an ad without the label is not a row). */
  total: OwnPerformanceTotals;
  /** Rows tied at the top spend — the dimension's spend leader(s). */
  leaders: OwnPerformanceRow[];
  /** Humanized leader value(s), joined for ties. */
  leaderLabel: string;
  /** Combined leader share of the dimension's spend, rounded. */
  leaderSharePct: number;
  /** Highest-ROAS row with a stated return, or null. */
  bestReturn: OwnPerformanceRow | null;
}

export interface OwnPerformanceCombination {
  hook: string;
  angle: string;
  format: string;
  adCount: number;
  spend: number;
  purchases: number;
  roas: number;
}

export interface OwnPerformanceHeadline {
  kind: 'best_return' | 'best_return_is_leader' | 'concentrated' | 'empty';
  /** Muted lead-in · the humanized value (emphasized) · muted tail. */
  lead: string;
  value: string;
  tail: string;
  /** `lead + value + tail` — the line print and the headless PDF use. */
  text: string;
}

export interface OwnPerformanceModel {
  windowDays: number;
  from: string;
  to: string;
  currency: string;
  basis: 'platform_reported';
  /** Labeled ads with spend that made it into the model. */
  labeledAdCount: number;
  labeledSpend: number;
  coverage: OwnPerformanceCoverage;
  scope: OwnPerformanceScope;
  currencyNote: string | null;
  truncated: boolean;
  dimensions: OwnPerformanceDimension[];
  combinations: OwnPerformanceCombination[];
  headline: OwnPerformanceHeadline;
  demo: boolean;
}

const EMPTY_HEADLINE: OwnPerformanceHeadline = {
  kind: 'empty',
  lead: 'No labeled ad spend yet',
  value: '',
  tail: '',
  text: 'No labeled ad spend yet',
};

export const EMPTY_OWN_PERFORMANCE: OwnPerformanceModel = {
  windowDays: DEFAULT_OWN_PERFORMANCE_WINDOW,
  from: '',
  to: '',
  currency: 'USD',
  basis: 'platform_reported',
  labeledAdCount: 0,
  labeledSpend: 0,
  coverage: {
    labeledAdsWithSpend: 0,
    totalAdsWithSpend: 0,
    labeledSpend: 0,
    totalSpend: 0,
  },
  scope: { pooled: false, brandCount: 0 },
  currencyNote: null,
  truncated: false,
  dimensions: [],
  combinations: [],
  headline: EMPTY_HEADLINE,
  demo: false,
};

/** True when there is nothing to show — the chapter hides on every track. */
export function isOwnPerformanceEmpty(
  model: OwnPerformanceModel | null | undefined,
): boolean {
  return !model || model.labeledAdCount === 0 || model.dimensions.length === 0;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

interface Bucket {
  adCount: number;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
}

function emptyBucket(): Bucket {
  return { adCount: 0, spend: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValue: 0 };
}

function addRow(bucket: Bucket, row: OwnPerformanceInputRow): void {
  bucket.adCount += 1;
  bucket.spend += row.spend;
  bucket.impressions += row.impressions;
  bucket.clicks += row.clicks;
  bucket.purchases += row.purchases;
  bucket.purchaseValue += row.purchaseValue;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Ratios recomputed from summed bases; returns withheld under the floor. */
export function performanceTotals(bucket: Bucket): OwnPerformanceTotals {
  const enoughPurchases = bucket.purchases >= MIN_PURCHASES_FOR_RETURN;
  return {
    ...bucket,
    roas: enoughPurchases && bucket.spend > 0 ? bucket.purchaseValue / bucket.spend : null,
    cpa: enoughPurchases ? bucket.spend / bucket.purchases : null,
    ctr: bucket.impressions > 0 ? (bucket.clicks / bucket.impressions) * 100 : null,
  };
}

/** Normalized token, or null for an absent/blank label. */
function token(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = normalizeAngleToken(raw);
  return normalized.length > 0 ? normalized : null;
}

/**
 * The value an ad carries for a dimension. Angle reads the industry `angle`
 * and falls back per-row to `angle_universal` — the same rule the market
 * priors use, so this chapter and Chapter 04 speak one vocabulary.
 */
export function labelValue(
  labels: OwnPerformanceLabels,
  dimension: OwnPerformanceDimensionKey,
): string | null {
  switch (dimension) {
    case 'hook_archetype':
      return token(labels.hookArchetype);
    case 'angle':
      return token(labels.angle) ?? token(labels.angleUniversal);
    case 'format':
      return token(labels.format);
    case 'offer_type':
      return token(labels.offerType);
    case 'persona':
      return token(labels.persona);
    case 'funnel_stage':
      return token(labels.funnelStage);
    default:
      return null;
  }
}

function compareRows(a: OwnPerformanceRow, b: OwnPerformanceRow): number {
  if (b.spend !== a.spend) return b.spend - a.spend;
  if (b.adCount !== a.adCount) return b.adCount - a.adCount;
  return a.value.localeCompare(b.value);
}

function buildDimension(
  spec: (typeof OWN_PERFORMANCE_DIMENSIONS)[number],
  rows: OwnPerformanceInputRow[],
): OwnPerformanceDimension | null {
  const byValue = new Map<string, Bucket>();
  const total = emptyBucket();
  for (const row of rows) {
    const value = labelValue(row.labels, spec.key);
    if (!value) continue;
    let bucket = byValue.get(value);
    if (!bucket) {
      bucket = emptyBucket();
      byValue.set(value, bucket);
    }
    addRow(bucket, row);
    addRow(total, row);
  }
  if (byValue.size === 0) return null;

  const dimensionRows: OwnPerformanceRow[] = [...byValue.entries()]
    .map(([value, bucket]) => ({
      value,
      ...performanceTotals(bucket),
      spendSharePct: total.spend > 0 ? (bucket.spend / total.spend) * 100 : 0,
    }))
    .sort(compareRows);

  const topSpend = dimensionRows[0].spend;
  // Crown ties jointly (never the display sort); crown nobody without spend.
  const leaders = topSpend > 0 ? dimensionRows.filter((row) => row.spend === topSpend) : [];
  const lead = leaders.length > 0 ? leaders : dimensionRows.slice(0, 1);

  const ranked = dimensionRows
    .filter((row) => row.roas != null)
    .sort((a, b) => {
      const diff = (b.roas as number) - (a.roas as number);
      return diff !== 0 ? diff : compareRows(a, b);
    });

  return {
    dimension: spec.key,
    label: spec.label,
    noun: spec.noun,
    rows: dimensionRows,
    total: performanceTotals(total),
    leaders: lead,
    leaderLabel: lead.map((row) => humanizeTagValue(row.value)).join(' + '),
    leaderSharePct: Math.round(lead.reduce((sum, row) => sum + row.spendSharePct, 0)),
    bestReturn: ranked[0] ?? null,
  };
}

/** hook × angle × format cells that clear every gate, best return first. */
function buildCombinations(
  rows: OwnPerformanceInputRow[],
  labeledSpend: number,
): OwnPerformanceCombination[] {
  if (!(labeledSpend > 0)) return [];
  const cells = new Map<string, { hook: string; angle: string; format: string; bucket: Bucket }>();
  for (const row of rows) {
    const hook = labelValue(row.labels, 'hook_archetype');
    const angle = labelValue(row.labels, 'angle');
    const format = labelValue(row.labels, 'format');
    if (!hook || !angle || !format) continue;
    const key = `${hook}|${angle}|${format}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { hook, angle, format, bucket: emptyBucket() };
      cells.set(key, cell);
    }
    addRow(cell.bucket, row);
  }

  const minSpend = (labeledSpend * COMBINATION_MIN_SPEND_SHARE_PCT) / 100;
  return [...cells.values()]
    .filter(
      ({ bucket }) =>
        bucket.adCount >= COMBINATION_MIN_ADS &&
        bucket.purchases >= COMBINATION_MIN_PURCHASES &&
        bucket.spend > 0 &&
        bucket.spend >= minSpend,
    )
    .map(({ hook, angle, format, bucket }) => ({
      hook,
      angle,
      format,
      adCount: bucket.adCount,
      spend: bucket.spend,
      purchases: bucket.purchases,
      roas: bucket.purchaseValue / bucket.spend,
    }))
    .sort(
      (a, b) =>
        b.roas - a.roas ||
        b.spend - a.spend ||
        `${a.hook}|${a.angle}|${a.format}`.localeCompare(`${b.hook}|${b.angle}|${b.format}`),
    )
    .slice(0, MAX_COMBINATIONS);
}

function headlineOf(
  lead: string,
  value: string,
  tail: string,
  kind: OwnPerformanceHeadline['kind'],
): OwnPerformanceHeadline {
  return { kind, lead, value, tail, text: `${lead}${value}${tail}` };
}

/**
 * The chapter's one-line answer, chosen by threshold — never generated. Reads
 * the angle dimension (the argument an ad makes, the brand-identity question)
 * and falls back to the first dimension in BUILD order that has rows.
 */
export function performanceHeadline(
  dimensions: OwnPerformanceDimension[],
  currency: string,
): OwnPerformanceHeadline {
  const focus =
    dimensions.find((dimension) => dimension.dimension === 'angle') ?? dimensions[0];
  if (!focus || focus.total.spend <= 0) return EMPTY_HEADLINE;

  const best = focus.bestReturn;
  if (!best || best.roas == null) {
    return headlineOf(
      'Not enough purchases yet to rank returns — spend is concentrated in ',
      focus.leaderLabel,
      ` (${formatSharePct(focus.leaderSharePct)} of ${focus.noun} spend)`,
      'concentrated',
    );
  }

  const value = humanizeTagValue(best.value);
  const figures = ` at ${formatRoas(best.roas)} on ${formatPerformanceMoney(best.spend, currency)}`;
  const isLeader = focus.leaders.some((row) => row.value === best.value);
  return isLeader
    ? headlineOf(
        `Your best-returning ${focus.noun} is `,
        value,
        `${figures}, and it already takes the most spend`,
        'best_return_is_leader',
      )
    : headlineOf(`Your best-returning ${focus.noun} is `, value, figures, 'best_return');
}

/**
 * Build the chapter model. Rows without spend are dropped first: the chapter
 * is spend-weighted, and an ad that spent nothing in the window is not
 * evidence of what is working.
 */
export function buildOwnPerformanceModel(input: OwnPerformanceInput): OwnPerformanceModel {
  const rows = input.rows
    .map((row) => ({
      ...row,
      spend: finite(row.spend),
      impressions: finite(row.impressions),
      clicks: finite(row.clicks),
      purchases: finite(row.purchases),
      purchaseValue: finite(row.purchaseValue),
    }))
    .filter((row) => row.spend > 0);
  const labeledSpend = rows.reduce((sum, row) => sum + row.spend, 0);

  const dimensions = OWN_PERFORMANCE_DIMENSIONS.map((spec) => buildDimension(spec, rows)).filter(
    (dimension): dimension is OwnPerformanceDimension => dimension != null,
  );

  return {
    windowDays: input.windowDays,
    from: input.from,
    to: input.to,
    currency: input.currency,
    basis: 'platform_reported',
    labeledAdCount: rows.length,
    labeledSpend,
    coverage: input.coverage,
    scope: input.scope,
    currencyNote: input.currencyNote ?? null,
    truncated: input.truncated === true,
    dimensions,
    combinations: buildCombinations(rows, labeledSpend),
    headline: performanceHeadline(dimensions, input.currency),
    demo: input.demo === true,
  };
}

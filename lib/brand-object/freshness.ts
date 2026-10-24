/**
 * Market-evidence freshness — PURE, zero IO.
 *
 * A `market_prior` fact distilled from competitors that stopped syncing months
 * ago reads identically to one distilled this morning. The authoritative
 * evidence age is `brand_facts.metrics.evidenceAsOf` (max
 * `tracked_competitors.last_synced_at` over the competitors backing the
 * dimension's winners), written by `distillMarketPriors`. `metrics` refresh on
 * EVERY reconcile touch and live OUTSIDE the brand-context row content hash,
 * so the timestamp self-updates on the normal distillation cadence and can
 * never re-mint brand_context_rows versions or move pack fingerprints.
 *
 * Copy rule: competitor scrapes run roughly every two weeks. Never say "this
 * week" / "weekly" in any surface built on these helpers.
 */
import type { FactMetrics } from './types';

/** ≈2 competitor scrape cycles. Past this, the evidence is called out. */
export const MARKET_EVIDENCE_STALE_AFTER_DAYS = 28;

const MS_PER_DAY = 86_400_000;

/** Badge text for a stale market prior — cadence-safe copy. */
export const MARKET_EVIDENCE_STALE_BADGE = 'Evidence >4 weeks old';

export interface MarketEvidenceAge {
  /** ISO timestamp of the newest competitor sync behind this fact. */
  evidenceAsOf: string | null;
  /** Older than MARKET_EVIDENCE_STALE_AFTER_DAYS. Never true without a date. */
  isStale: boolean;
  /** Whole days since `evidenceAsOf`; null when no date resolved. */
  ageDays: number | null;
}

/** Fact-shaped input — `metrics.evidenceAsOf` first, `updated_at` fallback. */
export interface MarketEvidenceInput {
  metrics?: FactMetrics | null;
  /** Row stamp (brand_facts.updated_at) when the caller selected it. */
  updated_at?: string | null;
}

function parseIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Evidence age for one market_prior fact. Absent/unparseable timestamps
 * degrade to `{evidenceAsOf: null, isStale: false}` — an unknown age is never
 * reported as stale.
 */
export function marketEvidenceAge(
  fact: MarketEvidenceInput,
  now: Date = new Date(),
): MarketEvidenceAge {
  const evidenceAsOf =
    parseIso(fact.metrics?.evidenceAsOf) ?? parseIso(fact.updated_at);
  if (!evidenceAsOf) return { evidenceAsOf: null, isStale: false, ageDays: null };
  const ageDays = Math.floor(
    (now.getTime() - Date.parse(evidenceAsOf)) / MS_PER_DAY,
  );
  return {
    evidenceAsOf,
    isStale: ageDays > MARKET_EVIDENCE_STALE_AFTER_DAYS,
    ageDays: ageDays,
  };
}

/** Words around the formatted date — a localized surface passes its catalog's. */
export interface MarketEvidenceLabelOptions {
  /** BCP 47 tag for the date (a UTC calendar date, so no zone shift); default en-US. */
  locale?: string;
  /** The sentence around the date; default the English provenance line. */
  template?: (_date: string) => string;
}

/**
 * User-facing provenance line, e.g.
 * `competitor evidence from Jul 2, 2026; scrapes run ~2-weekly`.
 * Null when no evidence date is known. One shared definition for the report,
 * the Brand Book and the Creative Studio composer: the composer and a
 * non-English book pass their own `template` + `locale`.
 */
export function marketEvidenceLabel(
  evidenceAsOf: string | null,
  options: MarketEvidenceLabelOptions = {},
): string | null {
  if (!evidenceAsOf) return null;
  const parsed = Date.parse(evidenceAsOf);
  if (Number.isNaN(parsed)) return null;
  const date = new Date(parsed).toLocaleDateString(options.locale ?? 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return options.template
    ? options.template(date)
    : `competitor evidence from ${date}; scrapes run ~2-weekly`;
}

/** Oldest evidence date across facts + how many are stale. */
export function summarizeMarketEvidence(
  facts: readonly MarketEvidenceInput[],
  now: Date = new Date(),
): { oldestEvidenceAt: string | null; staleCount: number } {
  let oldest: string | null = null;
  let staleCount = 0;
  for (const fact of facts) {
    const { evidenceAsOf, isStale } = marketEvidenceAge(fact, now);
    if (isStale) staleCount += 1;
    if (!evidenceAsOf) continue;
    if (!oldest || Date.parse(evidenceAsOf) < Date.parse(oldest)) {
      oldest = evidenceAsOf;
    }
  }
  return { oldestEvidenceAt: oldest, staleCount };
}

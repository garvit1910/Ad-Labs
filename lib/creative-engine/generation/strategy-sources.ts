/**
 * Strategy signal sources (IO) — the one DB-touching module of the strategy
 * selection layer. Reads the brand's `market_prior` facts (the competitor-
 * analysis distillation: winning-ad angle/hook/format/offer shares written by
 * the market processor) through the sanctioned `loadLiveBrandFacts` bulk door
 * and maps them onto pure `StrategySignal`s.
 *
 * The org's own realized-performance priors are NOT read here — the briefs
 * route already fetches (and multi-brand-gates) them, and maps them via the
 * pure `signalsFromPerformancePriors`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadLiveBrandFacts } from '@/lib/brand-object/live-facts';
import {
  summarizeMarketEvidence,
  type MarketEvidenceInput,
} from '@/lib/brand-object/freshness';
import type { StrategySignal } from './strategy';

const CORE_SIGNAL_DIMENSIONS = new Set<StrategySignal['dimension']>([
  'angle',
  'hook_archetype',
  'format',
  'offer_type',
  'persona',
]);

/** Execution dims (how winning ads are staged) — emitted AFTER core dims so
 * the MAX_EVIDENCE slice in tags.strategy.evidence keeps angle/hook lineage. */
const EXECUTION_SIGNAL_DIMENSIONS = new Set<StrategySignal['dimension']>([
  'style',
  'setting',
  'tone',
  'people_present',
  'aspect_ratio',
]);

/**
 * Map the profile's live market_prior facts → signals. Fact `details` carry
 * `{dimension, value, share, conceptCount}` (lib/brand-object/market.ts);
 * malformed rows are skipped, never thrown — strategy is an enrichment, not
 * a correctness dependency.
 */
export async function fetchMarketStrategySignals(
  db: SupabaseClient,
  scope: { organizationId: string; brandProfileId: string }
): Promise<StrategySignal[]> {
  const { signals } = await fetchMarketStrategySignalsWithEvidence(db, scope);
  return signals;
}

export interface MarketStrategySignalsResult {
  signals: StrategySignal[];
  /** Oldest `metrics.evidenceAsOf` across the facts that produced signals. */
  oldestEvidenceAt: string | null;
  /** How many of those facts are past the staleness threshold. */
  staleSignalCount: number;
}

/**
 * As `fetchMarketStrategySignals`, plus the evidence-age summary of the facts
 * that actually produced signals (lib/brand-object/freshness.ts). Surfaces
 * read this LIVE — nothing here touches brand_context_rows.
 */
export async function fetchMarketStrategySignalsWithEvidence(
  db: SupabaseClient,
  scope: { organizationId: string; brandProfileId: string }
): Promise<MarketStrategySignalsResult> {
  const facts = await loadLiveBrandFacts(db, scope);
  const coreSignals: StrategySignal[] = [];
  const executionSignals: StrategySignal[] = [];
  const contributingFacts: MarketEvidenceInput[] = [];
  for (const fact of facts) {
    if (fact.section !== 'market_prior') continue;
    const details = fact.details as {
      dimension?: unknown;
      value?: unknown;
      share?: unknown;
      conceptCount?: unknown;
    };
    const dimension = details.dimension;
    const value = details.value;
    if (typeof dimension !== 'string' || typeof value !== 'string' || value.length === 0) {
      // Fail-soft as before — but never silent: a malformed prior silently
      // shrinking the signal set is invisible without this line.
      console.warn('[StrategySources] skipping malformed market_prior fact', {
        organizationId: scope.organizationId,
        brandProfileId: scope.brandProfileId,
        factId: fact.id,
        factKey: fact.fact_key,
        dimension,
        value,
      });
      continue;
    }
    const isCore = CORE_SIGNAL_DIMENSIONS.has(
      dimension as StrategySignal['dimension'],
    );
    const isExecution = EXECUTION_SIGNAL_DIMENSIONS.has(
      dimension as StrategySignal['dimension'],
    );
    if (!isCore && !isExecution) continue;
    const share = typeof details.share === 'number' ? details.share : 0;
    // format/style fact evidence carries a winning ad's SANITIZED staging
    // notes as `quote` (market.ts writes them; sanitation happened there).
    const note =
      dimension === 'format' || dimension === 'style'
        ? (fact.evidence ?? []).find(
            (entry) =>
              typeof entry.quote === 'string' && entry.quote.length > 0,
          )?.quote
        : undefined;
    const signal: StrategySignal = {
      dimension: dimension as StrategySignal['dimension'],
      value,
      weight: Math.max(0, Math.min(1, share / 100)),
      source: 'market_prior',
      evidence: {
        share,
        ...(typeof details.conceptCount === 'number'
          ? { conceptCount: details.conceptCount }
          : {}),
        ...(note ? { note } : {}),
      },
    };
    (isCore ? coreSignals : executionSignals).push(signal);
    contributingFacts.push({ metrics: fact.metrics });
  }
  const { oldestEvidenceAt, staleCount } =
    summarizeMarketEvidence(contributingFacts);
  return {
    signals: [...coreSignals, ...executionSignals],
    oldestEvidenceAt,
    staleSignalCount: staleCount,
  };
}

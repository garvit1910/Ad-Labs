/**
 * "What's working" priors (Phase 4 item 5, v1) — derived from performance
 * rollups for the brief composer today and Phase 2's researcher step later
 * (both consume the same `performance_memory` read surface).
 *
 * Attributed (enhanced) ROAS is preferred when reconciled revenue exists;
 * platform ROAS is the fallback and the basis is always reported. Spend and
 * impression floors keep a lucky $3 ad from becoming a "prior".
 */

import { deriveRollupMetrics } from './rollup';
import {
  POOLED_MIN_DECAYED_CLICKS,
  POOLED_MIN_DECAYED_IMPRESSIONS,
  POOLED_MIN_DONOR_ORGS,
} from './posterior';
import type {
  DimensionRollup,
  PerformanceDimension,
  PerformancePriors,
  PooledColdStartCell,
  PriorEntry,
} from './types';

/** Minimum realized spend (account currency, whole units) before a value can be a prior. */
export const PRIOR_MIN_SPEND = 20;
export const PRIOR_MIN_IMPRESSIONS = 500;

export interface PriorOptions {
  minSpend?: number;
  minImpressions?: number;
}

function toPriorEntry(rollup: DimensionRollup): PriorEntry | null {
  // `deriveRollupMetrics` emits attributedRoas ONLY on the verified basis (see
  // loop/basis.ts), so this reads as "is this cell judged on the verified
  // ruler" rather than "did the reconciler touch it".
  const derived = deriveRollupMetrics(rollup);
  const basis: PriorEntry['basis'] = derived.attributedRoas !== null ? 'attributed' : 'platform';
  const roas = basis === 'attributed' ? derived.attributedRoas : derived.roas;
  if (roas === null) return null;
  return {
    dimension: rollup.dimension,
    value: rollup.dimensionValue,
    // The winning row's platform — priors blend across platforms deliberately
    // (top ROAS wins regardless of platform); this records which platform's
    // realized performance sourced the prior so the blend stays visible.
    platform: rollup.platform,
    roas,
    basis,
    captureRatio: rollup.captureRatio,
    spend: rollup.spend,
    impressions: rollup.impressions,
    adCount: rollup.adCount,
    fatigued: rollup.fatigue?.declining ?? false,
  };
}

function topFor(
  rollups: DimensionRollup[],
  dimension: PerformanceDimension,
  minSpend: number,
  minImpressions: number
): PriorEntry | null {
  const entries = rollups
    .filter(
      (rollup) =>
        rollup.dimension === dimension &&
        rollup.spend >= minSpend &&
        rollup.impressions >= minImpressions
    )
    .map(toPriorEntry)
    .filter((entry): entry is PriorEntry => entry !== null && !entry.fatigued);
  if (entries.length === 0) return null;
  return entries.reduce((best, entry) => ((entry.roas ?? 0) > (best.roas ?? 0) ? entry : best));
}

export function derivePerformancePriors(
  rollups: DimensionRollup[],
  options: PriorOptions = {}
): PerformancePriors {
  const minSpend = options.minSpend ?? PRIOR_MIN_SPEND;
  const minImpressions = options.minImpressions ?? PRIOR_MIN_IMPRESSIONS;

  const fatigued = rollups
    .filter((rollup) => rollup.fatigue?.declining)
    .map(toPriorEntry)
    .filter((entry): entry is PriorEntry => entry !== null);

  return {
    topAngle: topFor(rollups, 'angle', minSpend, minImpressions),
    topPersona: topFor(rollups, 'persona', minSpend, minImpressions),
    topHookArchetype: topFor(rollups, 'hook_archetype', minSpend, minImpressions),
    topStyle: topFor(rollups, 'style', minSpend, minImpressions),
    fatigued,
    thresholds: { minSpend, minImpressions },
  };
}

// ── Cold-start pooled priors (Workstream E Part 2) ───────────────────────────

const EMPTY_POOLED_PRIORS: PerformancePriors = {
  topAngle: null,
  topPersona: null,
  topHookArchetype: null,
  topStyle: null,
  fatigued: [],
  thresholds: { minSpend: PRIOR_MIN_SPEND, minImpressions: PRIOR_MIN_IMPRESSIONS },
};

/** The pooled dimensions and the PerformancePriors slot each one fills. */
const POOLED_SLOT_BY_DIMENSION: Record<string, 'topAngle' | 'topHookArchetype'> = {
  angle_universal: 'topAngle',
  hook_archetype: 'topHookArchetype',
};

/**
 * PURE. Derive cold-start priors from pooled cross-tenant label cells — the
 * `fetchIndustryPriorFallback` re-point (the industry table is empty and only
 * aggregates generated creatives, so it will stay empty for months).
 *
 * Per (dimension, value): duplicate cells are POOLED by summing decayed counts
 * BEFORE flooring, then Workstream D's pool-eligibility floors apply
 * (`POOLED_MIN_DECAYED_IMPRESSIONS` / `POOLED_MIN_DECAYED_CLICKS` — the same
 * "a 3-impression cell must not become borrowed evidence" rationale) PLUS the
 * `POOLED_MIN_DONOR_ORGS` k-floor: a cell standing on fewer than k distinct
 * donors is one merchant's real ROAS, and this value is persisted into the
 * borrowing org's `tags.performancePriors.roas`. `'other'`
 * is never a prior (it renders a nonsense directive). The top value per
 * dimension wins by decayed ROAS (decayedPurchaseValue / decayedSpend; zero
 * spend is unrankable and sinks); ties break to the higher decayed spend so
 * the more-substantiated value is kept.
 *
 * Fills ONLY `topAngle` (from `angle_universal` cells — the value is the ENUM
 * TOKEN, e.g. 'pain_relief') and `topHookArchetype`. THE TOKEN MUST NEVER
 * REACH THE COMPOSER VERBATIM — the route renders it through
 * `deterministicAngleDirective` on both consumption paths (the angle-verbatim
 * invariant). Empty or all-below-floor input → all-null priors (the composer
 * keeps its blueprint defaults; `isAllNullGenomePriors` reads true).
 */
export function derivePooledColdStartPriors(
  cells: PooledColdStartCell[]
): PerformancePriors {
  const pooled = new Map<string, PooledColdStartCell>();
  for (const cell of cells) {
    if (!(cell.dimension in POOLED_SLOT_BY_DIMENSION)) continue;
    if (cell.dimensionValue === 'other') continue;
    const key = `${cell.dimension}:${cell.dimensionValue}`;
    const existing = pooled.get(key);
    if (!existing) {
      pooled.set(key, { ...cell });
      continue;
    }
    existing.decayedSpend += cell.decayedSpend;
    existing.decayedImpressions += cell.decayedImpressions;
    existing.decayedClicks += cell.decayedClicks;
    existing.decayedPurchases += cell.decayedPurchases;
    existing.decayedPurchaseValue += cell.decayedPurchaseValue;
    // Pooling is per (dimension, value) and `performance_memory` is uniquely
    // keyed on (org, platform, dimension, value, source) with platform+source
    // pinned by the read, so every merged cell is a DISTINCT donor org.
    existing.donorCount += cell.donorCount;
  }

  const best = new Map<'topAngle' | 'topHookArchetype', PooledColdStartCell>();
  const roasOf = (c: PooledColdStartCell): number =>
    c.decayedSpend > 0 ? c.decayedPurchaseValue / c.decayedSpend : -1;
  for (const cell of pooled.values()) {
    if (
      cell.decayedImpressions < POOLED_MIN_DECAYED_IMPRESSIONS ||
      cell.decayedClicks < POOLED_MIN_DECAYED_CLICKS ||
      // K-ANONYMITY — below k donors the ROAS this fills into the borrowing
      // org's brief IS a single merchant's number.
      cell.donorCount < POOLED_MIN_DONOR_ORGS
    ) {
      continue;
    }
    const slot = POOLED_SLOT_BY_DIMENSION[cell.dimension];
    const current = best.get(slot);
    if (!current) {
      best.set(slot, cell);
      continue;
    }
    const a = roasOf(cell);
    const b = roasOf(current);
    if (a > b || (a === b && cell.decayedSpend > current.decayedSpend)) {
      best.set(slot, cell);
    }
  }

  if (best.size === 0) return EMPTY_POOLED_PRIORS;

  const toEntry = (
    slot: 'topAngle' | 'topHookArchetype',
    dimension: PerformanceDimension
  ): PriorEntry | null => {
    const cell = best.get(slot);
    if (!cell) return null;
    return {
      // The SLOT dimension label ('angle' / 'hook_archetype'), mirroring the
      // industry fallback — consumers key on the slot, not the source cell.
      dimension,
      value: cell.dimensionValue,
      platform: 'meta',
      roas: cell.decayedSpend > 0 ? cell.decayedPurchaseValue / cell.decayedSpend : null,
      // Pooled label cells are platform-basis by construction (the verified
      // ruler never crosses tenants); capture is "not measured", not zero.
      basis: 'platform',
      captureRatio: null,
      spend: cell.decayedSpend,
      impressions: cell.decayedImpressions,
      // Cross-tenant pool — "adCount" reports the DONOR ORG count (one per
      // contributing row), mirroring the industry fallback's merchant-count
      // semantics; it is always >= POOLED_MIN_DONOR_ORGS by the gate above.
      adCount: cell.donorCount,
      fatigued: false,
    };
  };

  return {
    ...EMPTY_POOLED_PRIORS,
    topAngle: toEntry('topAngle', 'angle'),
    topHookArchetype: toEntry('topHookArchetype', 'hook_archetype'),
  };
}

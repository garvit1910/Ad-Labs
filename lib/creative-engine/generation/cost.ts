/**
 * Generation cost estimation + per-org monthly budget assertion.
 *
 * Wide generation multiplies spend ("generation APIs are the new Apify"), so
 * every run is estimated up front and gated against an env-capped monthly
 * budget. NO DB access here — the month-to-date spend read is an INJECTED
 * seam (`countCentsThisMonth`) that W2 wires to persistence. Pattern:
 * services/ad-library/ingestion-budget.ts.
 */

import type {
  AspectRatio,
  CreativeBrief,
  CreativeImageProvider,
  GenerationRunOptions,
  ImageQuality,
} from './types';
import { dimensionsForAspectRatio, resolveDefaultProviders } from './providers';
import { resolveJudgeGateMode } from './judge-gate';

const DEFAULT_MONTHLY_CAP_CENTS = 20_000;
const DEFAULT_CANDIDATE_COUNT = 4;
const MIN_CANDIDATE_COUNT = 1;
const MAX_CANDIDATE_COUNT = 40;
const DEFAULT_PROPOSE_COUNT = 5;
/** Flat per-run overhead for judge/ranking LLM calls. */
const JUDGE_OVERHEAD_CENTS = 5;

function envPositiveInt(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/** Wide-generation candidate count: options → CREATIVE_GEN_WIDE_COUNT → 4, clamped 1..40 (the composer offers a single creative). */
export function resolveCandidateCount(options?: GenerationRunOptions): number {
  const requested =
    options?.candidateCount ?? envPositiveInt('CREATIVE_GEN_WIDE_COUNT') ?? DEFAULT_CANDIDATE_COUNT;
  return Math.min(MAX_CANDIDATE_COUNT, Math.max(MIN_CANDIDATE_COUNT, Math.floor(requested)));
}

/** Top-k propose count: options → CREATIVE_GEN_PROPOSE_COUNT → 5. */
export function resolveProposeCount(options?: GenerationRunOptions): number {
  const requested =
    options?.proposeCount ?? envPositiveInt('CREATIVE_GEN_PROPOSE_COUNT') ?? DEFAULT_PROPOSE_COUNT;
  return Math.max(1, Math.floor(requested));
}

/** Monthly per-org generation cap in cents (CREATIVE_GEN_MONTHLY_CAP_CENTS, default 20000). */
export function getCreativeGenMonthlyCapCents(): number {
  return envPositiveInt('CREATIVE_GEN_MONTHLY_CAP_CENTS') ?? DEFAULT_MONTHLY_CAP_CENTS;
}

const WIDE_QUALITY_VALUES: ImageQuality[] = ['low', 'medium', 'high'];

/**
 * Quality tier for the wide-generation pass (CREATIVE_GEN_WIDE_QUALITY,
 * default 'medium'). 'low' unlocks the cheap-wide → judge-rank economics
 * (~$0.006/image on gpt-image-2) but until the premium top-k RE-RENDER stage
 * exists (planned follow-up), approved creatives ship at the wide tier — so
 * the default stays 'medium'. Flip to 'low' only alongside the re-render.
 */
export function resolveWideQuality(): ImageQuality {
  const raw = (process.env.CREATIVE_GEN_WIDE_QUALITY || '').trim().toLowerCase();
  return (WIDE_QUALITY_VALUES as string[]).includes(raw) ? (raw as ImageQuality) : 'medium';
}

export interface WideRunEstimateOptions {
  /**
   * Whether this run will actually run the brand judge gate. The processor
   * injects the judge ONLY for brand-stamped briefs, so a LEGACY (packless)
   * brief can never spend judge cents — counting them inflates both the
   * estimate and the monthly budget assert it feeds.
   *
   * OMITTED = assume brand-stamped (the historical behavior). Callers that
   * cannot yet know (the composer's pre-brief `estimateOnly` estimate) keep
   * the conservative, brand-identical number.
   */
  brandStamped?: boolean;
  /**
   * How many brand-copy LLM calls this run makes — one per strategy group
   * that receives candidates (per-group copy, 2026-08); 1 for a legacy
   * single-copy brand run. Counted as `min(copyGroupCount, candidateCount)`
   * copy cents, and ONLY for a brand-stamped run (a packless brief never
   * calls the brand copywriter). OMITTED = no copy cents at all. The runs
   * route's pre-brief `estimateOnly` estimate passes `candidateCount` (the
   * upper bound — groups are unknown before a brief exists), so the composer
   * footer never reads below what the queued brand-stamped run is estimated at.
   */
  copyGroupCount?: number;
}

/**
 * Estimate a wide-generation run's cost WITHOUT a brief: per-provider
 * `estimateCostCents` × the round-robin candidate distribution + a flat judge
 * overhead. THE single source of truth for run estimation — the brief-aware
 * `estimateRunCostCents` delegates here, and the runs route's `estimateOnly`
 * pre-run estimate (composer footer, no brief yet) calls it directly.
 */
export function estimateWideRunCents(
  options?: GenerationRunOptions,
  aspectRatio: AspectRatio = '1:1',
  providers?: CreativeImageProvider[],
  estimateOptions?: WideRunEstimateOptions
): number {
  const pool = providers && providers.length > 0 ? providers : resolveDefaultProviders();
  const candidateCount = resolveCandidateCount(options);
  const dims = dimensionsForAspectRatio(aspectRatio);
  const quality = resolveWideQuality();
  let total = JUDGE_OVERHEAD_CENTS;
  // Judge-gate cents per candidate (judge v2: gpt-4o + reference image at
  // 3¢/candidate is no longer noise the flat overhead absorbs — 24
  // candidates ≈ 72¢). Skipped when the gate is off entirely OR when the run
  // is known not to be brand-stamped (the judge is never injected there).
  const brandStamped = estimateOptions?.brandStamped ?? true;
  if (brandStamped && resolveJudgeGateMode() !== 'off') {
    total += candidateCount * getJudgeGateCostCents();
  }
  // Per-strategy-group brand copy (2026-08): N calls per run, capped by the
  // candidate count (round-robin gives groups past index candidateCount-1 no
  // candidates at all, so they are never generated).
  const copyGroupCount = estimateOptions?.copyGroupCount ?? 0;
  if (brandStamped && copyGroupCount > 0) {
    total += Math.min(copyGroupCount, candidateCount) * getBrandCopyCostCents();
  }
  for (let i = 0; i < candidateCount; i += 1) {
    total += pool[i % pool.length].estimateCostCents({ ...dims, quality });
  }
  return total;
}

/**
 * Flat per-copy-candidate LLM cost estimate (cents) for a copy-only (Google
 * RSA) run. One cheap tool-calling completion per candidate SET (~1K output
 * tokens on gpt-5.4-mini ≈ $0.005 ≈ 1 cent, rounded generously to keep the
 * budget assert honest). Env-overridable via CREATIVE_RSA_COPY_COST_CENTS.
 */
const DEFAULT_RSA_COPY_CANDIDATE_CENTS = 1;

export function getRsaCopyCandidateCents(): number {
  return envPositiveInt('CREATIVE_RSA_COPY_COST_CENTS') ?? DEFAULT_RSA_COPY_CANDIDATE_CENTS;
}

/**
 * Flat per-COPY-CALL brand-copywriter LLM cost (cents) for a brand-mode image
 * run. Since per-group copy (2026-08) a run makes ONE call per strategy group
 * that receives candidates, so the run pays this N times; each group's cent is
 * charged durably on the FIRST candidate of that group (global index = group
 * index under round-robin). It rides `estimateWideRunCents` only through the
 * explicit `copyGroupCount` estimate input — the runs route passes the
 * brief's real group count, or `candidateCount` (the upper bound) for the
 * pre-brief estimate. Env: CREATIVE_BRAND_COPY_COST_CENTS.
 */
const DEFAULT_BRAND_COPY_CENTS = 2;

export function getBrandCopyCostCents(): number {
  return envPositiveInt('CREATIVE_BRAND_COPY_COST_CENTS') ?? DEFAULT_BRAND_COPY_CENTS;
}

/**
 * Flat per-JUDGED-candidate brand judge-gate LLM cost (cents) — one
 * gpt-4o vision call per candidate (judge v2 default, see judge-gate.ts's
 * DEFAULT_JUDGE_GATE_MODEL; brand-context Phase 6). Charged
 * durably on the candidate's cost_cents when the policy gate actually
 * returned verdicts; deliberately NOT folded into estimateRunCostCents (the
 * flat JUDGE_OVERHEAD_CENTS run overhead absorbs estimate noise).
 * Env: CREATIVE_JUDGE_GATE_COST_CENTS.
 */
const DEFAULT_JUDGE_GATE_CENTS = 3;

export function getJudgeGateCostCents(): number {
  return envPositiveInt('CREATIVE_JUDGE_GATE_COST_CENTS') ?? DEFAULT_JUDGE_GATE_CENTS;
}

/**
 * Estimate a copy-only (RSA) run's cost: `candidateCount` cheap LLM copy calls
 * + the flat judge/ranking overhead. Text runs are cheap but MUST still ride
 * the monthly budget assert — this is the honest estimate that feeds it.
 */
export function estimateRsaCopyRunCents(options?: GenerationRunOptions): number {
  const candidateCount = resolveCandidateCount(options);
  return JUDGE_OVERHEAD_CENTS + candidateCount * getRsaCopyCandidateCents();
}

/**
 * Estimate a run's cost from its brief (first aspect ratio drives dimensions).
 * `providers` defaults to the env-resolved pool; the pipeline passes its
 * injected pool for consistency. Copy-only (Google RSA) briefs route to the
 * cheap text estimator instead of the per-image provider pricing.
 *
 * `estimateOptions.brandStamped` threads through unchanged — the pipeline
 * knows (it holds the resolved brandContext dep); pre-brief callers omit it.
 */
export function estimateRunCostCents(
  brief: CreativeBrief,
  options?: GenerationRunOptions,
  providers?: CreativeImageProvider[],
  estimateOptions?: WideRunEstimateOptions
): number {
  if (brief.platform === 'google') {
    return estimateRsaCopyRunCents(options);
  }
  return estimateWideRunCents(
    options,
    brief.aspectRatios[0] ?? '1:1',
    providers,
    estimateOptions
  );
}

/**
 * Thrown when a run would push the org past its monthly generation cap.
 * Non-retryable; route callers translate it to a structured 429.
 */
export class CreativeBudgetError extends Error {
  readonly code = 'GENERATION_BUDGET_EXCEEDED';
  readonly reason: string;
  readonly remediation: string;
  readonly used: number;
  readonly cap: number;

  constructor(used: number, cap: number, addCents: number) {
    const reason = `Monthly creative-generation budget exceeded: ${used}c used + ${addCents}c requested > ${cap}c cap.`;
    super(reason);
    this.name = 'CreativeBudgetError';
    this.reason = reason;
    this.used = used;
    this.cap = cap;
    this.remediation =
      'Wait for the next calendar month or raise CREATIVE_GEN_MONTHLY_CAP_CENTS for this deployment.';
  }
}

export interface CreativeBudgetDeps {
  /**
   * Month-to-date creative-generation spend (cents) for the org. Injected by
   * the caller (W2 persistence layer) — this lib never touches the DB.
   */
  countCentsThisMonth: (_organizationId: string) => Promise<number>;
}

/**
 * Assert the org can afford `addCents` more generation spend this month.
 * Throws {@link CreativeBudgetError} when `used + addCents` exceeds the cap.
 * FAILS OPEN when the spend read rejects — a budget-read hiccup must never
 * block legitimate generation (the cap is a cost ceiling, not a security
 * boundary). Pattern: services/ad-library/ingestion-budget.ts.
 */
export async function assertCreativeGenerationBudget(
  deps: CreativeBudgetDeps,
  organizationId: string,
  addCents: number
): Promise<{ used: number; cap: number }> {
  const cap = getCreativeGenMonthlyCapCents();
  let used: number;
  try {
    used = await deps.countCentsThisMonth(organizationId);
  } catch (error) {
    console.warn(
      `[CreativeGenBudget] Could not read spend for org ${organizationId}; allowing:`,
      error instanceof Error ? error.message : error
    );
    return { used: 0, cap };
  }
  if (used + addCents > cap) {
    throw new CreativeBudgetError(used, cap, addCents);
  }
  return { used, cap };
}

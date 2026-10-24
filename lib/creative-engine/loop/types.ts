/**
 * Creative Engine Phase 4 — closed-loop contracts.
 *
 * The loop joins realized ad performance (`ad_daily_metrics`) back through the
 * publish linkage (`generated_creatives.published_ad_id`, M3.3) to the creative
 * genome, rolling results up to brand-object dimensions (`performance_memory`).
 * Everything in `lib/creative-engine/loop/` is pure aggregation over these
 * shapes — DB I/O lives only in `service.ts`.
 *
 * Dimension taxonomy mirrors the genome (angle/persona/hookArchetype/style) plus
 * the candidate's aspect_ratio ("format" in the handoff doc's persona/angle/
 * hook/format keying). Phase 2's strategy engine and the edit-distance online
 * metric key on the SAME taxonomy — do not fork it per consumer.
 */

import type { AdFingerprint } from '@/services/ad-library/label-taxonomy';
import type { ProportionCI } from '@/lib/agent/evals/statistics';

/**
 * Genome-side dimensions (the original loop). Published-candidate rollups key on
 * exactly these — the shared taxonomy Phase 2's strategy engine + edit-distance
 * + priors all read. Never fork this per consumer.
 */
export const PERFORMANCE_DIMENSIONS = [
  'angle',
  'persona',
  'hook_archetype',
  'style',
  'aspect_ratio',
] as const;

/**
 * Label-only dimensions (PR 3b) — the own_ad_labels attributes beyond the shared
 * five. Rolled up under `source: 'label'` so they answer "does
 * talking_head/tone=humorous/funnel=bof_offer win FOR US". These never flow into
 * priors (the composer applies the winning angle VERBATIM — a label enum token as
 * a brief angle would be meaningless prose), so they stay off the genome taxonomy.
 */
export const LABEL_PERFORMANCE_DIMENSIONS = [
  'format',
  'offer_type',
  'funnel_stage',
  'persona_universal',
  'angle_universal',
  'tone',
  'setting',
  'pacing',
  'talking_head',
  'text_overlay',
  'people_present',
  'voiceover',
  'captions',
  'music',
  'duration_bucket',
] as const;

/** Union of both dimension sets — the full performance_memory dimension domain. */
export const ALL_PERFORMANCE_DIMENSIONS = [
  ...PERFORMANCE_DIMENSIONS,
  ...LABEL_PERFORMANCE_DIMENSIONS,
] as const;

export type PerformanceDimension = (typeof ALL_PERFORMANCE_DIMENSIONS)[number];

/** Rollup source discriminator — genome-based vs own-ad-label-based. */
export type RollupSource = 'genome' | 'label';

/**
 * Which purchase ruler a cell is judged on: what the platform claimed, or what
 * Adcero's own attribution verified. Resolved by `loop/basis.ts` from the
 * capture ratio — never from a null check on the enhanced columns.
 */
export type MetricBasis = 'platform' | 'attributed';

/** A published candidate joined for the loop (subset of `generated_creatives`). */
export interface PublishedCandidateInput {
  id: string;
  publishedAdId: string;
  /** ISO timestamp; null only for legacy rows published before the column landed. */
  publishedAt: string | null;
  platform: string;
  aspectRatio: string;
  rankScore: number | null;
  judgeVersion: string | null;
  genome: {
    angle?: string;
    persona?: string;
    /**
     * Closed-taxonomy roll-ups of the freeform angle/persona (Workstream B).
     * These are the values that let a generated ad and a labeled imported ad
     * share a `performance_memory` cell — the prose `angle`/`persona` above stay
     * the verbatim attribution keys and keep their own (unshared) dimensions.
     * Absent on rows stamped before B until the backfill runs → no cell.
     */
    angleUniversal?: string;
    personaUniversal?: string;
    hookArchetype?: string;
    /** StrategyGroup ad format (Workstream B) — the label side's `format` twin. */
    format?: string;
    style?: string;
    /**
     * Deterministic overlay outcome stamped at generation (PR 4). Rolled up as
     * the `text_overlay` dimension (shared with the label side) ONLY when a
     * boolean is present — absent on historical rows → no cell.
     */
    textOverlay?: boolean;
  };
}

/** One `ad_daily_metrics` row (subset). Numerics arrive as number via PostgREST. */
export interface DailyMetricInput {
  adId: string;
  /** ISO date (date_start). */
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  /** Attribution-reconciled counterparts; null until reconciliation ran for the day. */
  enhancedPurchases: number | null;
  enhancedPurchaseValue: number | null;
}

/**
 * One own-ad label row joined for the loop (camelCase subset of `own_ad_labels`).
 * `platform` is resolved from the `ads` row (own_ad_labels has no platform column).
 * One label row per ad — the loop keys the label rollup itemId on `adId`.
 */
export interface LabeledAdInput {
  adId: string;
  platform: string;
  label: {
    hookArchetype?: string;
    angle?: string;
    angleUniversal?: string;
    persona?: string;
    personaUniversal?: string;
    funnelStage?: string;
    format?: string;
    style?: string;
    aspectRatio?: string;
    offerType?: string;
    fingerprint?: AdFingerprint | null;
  };
}

/**
 * A known-poisoned metric window (`metric_contamination_windows`). The loop
 * excludes these days so a double-counted CAPI replay never becomes a "lesson".
 * `metricScope` is free text in the DB (default 'purchases'), so consumers must
 * treat an unrecognized scope conservatively.
 */
export interface ContaminationWindow {
  platform: string;
  metricScope: string;
  /** Inclusive ISO date bounds. */
  dateStart: string;
  dateEnd: string;
}

/** CTR-decline fatigue signal for one dimension value (min-sample gated). */
export interface FatigueSignal {
  /** Recent-half CTR (clicks/impressions over the later half of the window). */
  ctrRecent: number;
  /** Prior-half CTR. */
  ctrPrior: number;
  /** True when recent CTR fell below FATIGUE_DECLINE_RATIO × prior CTR. */
  declining: boolean;
}

/** One rolled-up (dimension, value) row — the `performance_memory` shape. */
export interface DimensionRollup {
  platform: string;
  /** Which rollup produced this row — genome (published candidates) or own-ad labels. */
  source: RollupSource;
  dimension: PerformanceDimension;
  dimensionValue: string;
  candidateCount: number;
  adCount: number;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  /**
   * Time-decayed twins of the raw sums above (Workstream C). Each contributing
   * day is weighted `0.5^(ageDays / DECAY_HALF_LIFE_DAYS)` against the rollup's
   * injected `asOf`, so recent evidence outweighs old and a champion cannot
   * coast on stale glory. Always <= the raw value. These are what the bandit's
   * belief curves consume; the raw sums stay untouched so every existing
   * consumer — and every absolute-count gate, including the verified-basis
   * one — behaves exactly as before.
   */
  decayedSpend: number;
  decayedImpressions: number;
  decayedClicks: number;
  decayedPurchases: number;
  decayedPurchaseValue: number;
  /** Summed over reconciled rows only; null when no contributing row is reconciled. */
  enhancedPurchases: number | null;
  enhancedPurchaseValue: number | null;
  /**
   * Share of contributing daily rows the reconciler TOUCHED (0–1). This is a
   * row-touch ratio, NOT a measure of how much of reality the verified layer
   * caught — it saturates to 1.0 for any reconciled org because the reconciler
   * writes explicit zeroes. Kept for continuity; never gate a basis on it. Use
   * `captureRatio`.
   */
  enhancedCoverage: number;
  /**
   * Verified ÷ platform-claimed purchases — the honest capture measure. Null
   * when the platform claimed nothing or the verified layer never ran.
   */
  captureRatio: number | null;
  /** Which purchase ruler this cell may be judged on (see `loop/basis.ts`). */
  basis: MetricBasis;
  /** Mean pre-flight rank score of contributing candidates (null when none scored). */
  meanRankScore: number | null;
  /** Observed data window (ISO dates); null when no metric rows exist yet. */
  windowStart: string | null;
  windowEnd: string | null;
  /** Null when either window half misses the impression floor. */
  fatigue: FatigueSignal | null;
}

/** Read-time derived metrics — never stored (matches the ads-manager RPC posture). */
export interface DerivedRollupMetrics {
  ctr: number | null;
  cpc: number | null;
  roas: number | null;
  cpa: number | null;
  /**
   * Attributed ROAS, emitted ONLY when the cell's resolved basis is
   * 'attributed'. Null on platform basis — so downstream `attributedRoas !==
   * null` checks read as "is this cell judged on the verified ruler", which is
   * the question they were always trying to ask.
   */
  attributedRoas: number | null;
}

// ── Belief curves (Workstream D) ─────────────────────────────────────────────

/**
 * One pooled cross-tenant cell feeding the belief priors — the PriorSource seam
 * shape. DELIBERATELY carries no organization id: the fetcher strips it, so the
 * pure prior derivation structurally cannot see whose data it is borrowing.
 * Swapping the borrowing source (e.g. to `industry_benchmarks` once it fills) means
 * swapping the one fetcher that produces this shape, nothing downstream.
 *
 * `donorCount` is how k-anonymity survives that anonymity: the count travels,
 * the identities do not, so the pure layer can enforce a distinct-donor floor
 * without ever learning who the donors are.
 */
export interface PriorCellInput {
  dimension: string;
  dimensionValue: string;
  decayedImpressions: number;
  decayedClicks: number;
  decayedPurchases: number;
  /** Distinct donor orgs behind this cell (1 per `performance_memory` row). */
  donorCount: number;
}

/**
 * One pooled cross-tenant cell feeding the COLD-START prior fallback
 * (Workstream E Part 2 — the `fetchIndustryPriorFallback` re-point). Same
 * org-anonymous posture as `PriorCellInput`, plus the revenue columns the
 * ROAS ranking needs. A separate shape so Workstream D's belief-prior seam
 * does not widen.
 */
export interface PooledColdStartCell {
  dimension: string;
  dimensionValue: string;
  decayedSpend: number;
  decayedImpressions: number;
  decayedClicks: number;
  decayedPurchases: number;
  decayedPurchaseValue: number;
  /** Distinct donor orgs behind this cell (1 per `performance_memory` row). */
  donorCount: number;
}

/**
 * Where a layer's prior came from, per the fallback chain:
 * 'pooled' (this exact dimension value cleared the pool floor) →
 * 'dimension' (the dimension-wide pooled average) →
 * 'vague' (Beta(1,1) — deliberate Thompson optimism, not a bug).
 */
export type BeliefPriorSource = 'pooled' | 'dimension' | 'vague';

/** One Beta belief curve — "number plus how sure we are" for a yes/no rate. */
export interface BeliefCurve {
  alpha: number;
  beta: number;
  /** Posterior mean α/(α+β). */
  mean: number;
  /** Normal-approx 95% credible interval, clamped to [0, 1]. */
  ci95: [number, number];
  /** Which rung of the prior fallback chain seeded this curve. */
  source: BeliefPriorSource;
  /** Prior α+β (incl. the vague floor). Evidence ESS = α+β − priorEss. */
  priorEss: number;
}

/**
 * WHAT THE LOOP OPTIMIZES (`organizations.settings.creativeFence.objective`).
 * Absent = `'ctr'`, which is byte-identical to every number recorded before the
 * objective layer existed. `'cpc'` is an ALIAS of `'ctr'` — cost per click and
 * click-through order arms identically at a fixed CPM, and the loop observes no
 * per-cell CPM, so faking a cost model would invent structure the data cannot
 * support. Rulers, floors and the fallback stamp: `loop/objective.ts`.
 */
export type CreativeObjective = 'ctr' | 'cpc' | 'roas' | 'cpa';

/**
 * The two scorecards per cell (Workstream D), persisted as `scores.beliefs` in the
 * SAME sweep upsert that writes the row — the upsert REPLACES the whole `scores`
 * object, so a belief written by any other writer would be wiped at the next sweep.
 *
 * The objective layer deliberately does NOT widen this shape: an objective curve
 * is derived at read time from the row's decayed counts (`loop/objective.ts`),
 * so turning the setting on cannot move a single byte of persisted `scores`.
 */
export interface CellBeliefs {
  v: 1;
  /**
   * Purchase-layer ruler. Always 'platform' in v1: no decayed verified twins exist
   * in storage, so a verified-basis purchase posterior is impossible from stored
   * data. This field is the audit trail for that compromise.
   */
  basis: 'platform';
  /** Clicks-per-impression — fills fast, prunes duds. */
  click: BeliefCurve;
  /** Purchases-per-click — fills slowly, is the truth. */
  purchase: BeliefCurve;
}

// ── Score↔outcome calibration ────────────────────────────────────────────────

export interface CalibrationSample {
  candidateId: string;
  rankScore: number;
  judgeVersion: string;
  impressions: number;
  clicks: number;
  spend: number;
  purchaseValue: number;
  enhancedPurchaseValue: number | null;
}

export interface CalibrationCorrelation {
  /** Spearman rank correlation in [-1, 1]; null when undefined (constant series). */
  spearman: number | null;
  n: number;
}

export type CalibrationStatus = 'ok' | 'insufficient_sample';

/**
 * The scoring system's own KPI: does the pre-flight rank_score predict realized
 * outcomes? Expect ~no signal at first — iterate the rubric against THIS, not
 * against taste (roadmap Phase 4).
 */
export interface ScoreCalibrationReport {
  status: CalibrationStatus;
  /** Candidates that cleared the impression floor AND carry a rank score. */
  n: number;
  /** Candidates excluded for missing score or insufficient impressions. */
  excluded: number;
  minImpressions: number;
  minSamples: number;
  ctr: CalibrationCorrelation | null;
  roas: CalibrationCorrelation | null;
  /** Attributed (enhanced) ROAS — only over samples with reconciled revenue. */
  attributedRoas: CalibrationCorrelation | null;
  byJudgeVersion: Record<string, { n: number; ctr: CalibrationCorrelation | null }>;
}

// ── Human edit-distance (online/monitoring — NEVER a merge gate) ─────────────

/** Candidate subset the edit-distance metric reads. */
export interface EditDistanceCandidateInput {
  id: string;
  status: string;
  aspectRatio: string;
  genome: PublishedCandidateInput['genome'];
  editLineage: Array<{ actor?: string }>;
  editHistory: Array<{ decision?: string }>;
}

export interface EditDistanceCell {
  dimension: PerformanceDimension;
  dimensionValue: string;
  decided: number;
  approved: number;
  rejected: number;
  humanEditSteps: number;
  agentEditSteps: number;
  /** Approved candidates that needed ZERO human/agent edits — the headline. */
  zeroEditApprovals: number;
  /** zeroEditApprovals / approved; null when nothing approved. */
  zeroEditApprovalRate: number | null;
  /** (human+agent edit steps) / approved; null when nothing approved. */
  meanEditsPerApproved: number | null;
  /** rejected / decided; null when nothing decided. */
  rejectionRate: number | null;
}

export interface EditDistanceReport {
  overall: Omit<EditDistanceCell, 'dimension' | 'dimensionValue'>;
  byDimension: EditDistanceCell[];
}

// ── "What's working" priors (feed the brief composer / Phase 2 researcher) ──

export interface PriorEntry {
  dimension: PerformanceDimension;
  value: string;
  /**
   * The platform of the WINNING rollup row for this dimension (`performance_memory.platform`).
   * Priors DELIBERATELY blend across platforms — the top ROAS row for a dimension
   * wins regardless of platform (that IS the cross-platform learning feature). This
   * field makes the blend VISIBLE so provenance can record which platform's realized
   * performance sourced the prior (see the composer's `tags.performancePriors`).
   */
  platform: string;
  /** Attributed ROAS when the cell resolved to the verified basis, else platform ROAS. */
  roas: number | null;
  basis: MetricBasis;
  /** The capture ratio that decided `basis` — surfaced so the choice is auditable. */
  captureRatio: number | null;
  spend: number;
  impressions: number;
  adCount: number;
  fatigued: boolean;
}

export interface PerformancePriors {
  topAngle: PriorEntry | null;
  topPersona: PriorEntry | null;
  topHookArchetype: PriorEntry | null;
  /**
   * Top realized-performance visual style. Its value is a `VISUAL_STYLES`
   * member once the genome-style backfill + re-rollup lands; until then old
   * rows may carry prose (consumers guard before applying).
   */
  topStyle: PriorEntry | null;
  fatigued: PriorEntry[];
  /** Floors applied — surfaced so consumers can report why priors are absent. */
  thresholds: { minSpend: number; minImpressions: number };
}

// ── Brand-fact write-back seam (Phase 1 consumer — NOT persisted yet) ────────

/**
 * A typed fact candidate derived from performance_memory. Persisted into
 * `brand_facts` (section `performance_prior`, source `performance_derivation`)
 * by `writePerformanceFacts` via `loop/fact-mapping.ts` — the deterministic
 * supersession + evidence gate the Phase 1 note always pointed at. Evidence is
 * an EXTERNAL signal (realized spend/ROAS), never an LLM self-assessment.
 */
export interface PerformanceFactCandidate {
  subject: string;
  relation: string;
  object: string;
  confidence: number;
  evidence: PerformanceFactEvidence;
  /**
   * The ROAS this lesson asserts (Workstream H). Null on a fatigue lesson, which
   * makes no ROAS claim. Before H the materiality gate regex-parsed this back
   * out of `object`; the number now travels AS a number, so the gate is
   * structural and editing the statement template cannot silently break it.
   */
  roas: number | null;
  /** True for `creative_fatigue` — a state claim, not a ROAS claim. */
  fatigued: boolean;
  /**
   * The cell's belief curves at derivation time (Workstream H). Snapshotted onto
   * the written fact's `details`, which is what lets the bi-temporal
   * `brand_facts` table answer "what did we believe on date X" for CURVES, and
   * what gives the materiality gate's Bayesian arm something to compare against.
   * Null when the caller supplied no prior table.
   */
  beliefs: CellBeliefs | null;
}

/**
 * Receipts for one derived lesson. Carries the cell identity and the RULER —
 * a lesson whose basis and capture ratio are not recorded cannot be audited
 * later, and cannot be compared against a lesson measured differently.
 */
export interface PerformanceFactEvidence {
  source_metric: string;
  spend: number;
  impressions: number;
  adCount: number;
  windowStart: string | null;
  windowEnd: string | null;
  derivedFrom: 'performance_memory';
  platform: string;
  rollupSource: RollupSource;
  dimension: PerformanceDimension;
  dimensionValue: string;
  basis: MetricBasis;
  captureRatio: number | null;
  /**
   * The LEAVE-ONE-OUT PEER POOL this value was compared against before a
   * `top_performing` lesson was allowed (the floors gate on LEVEL; this gate is
   * the one that gates on DIFFERENCE). Present only on `top_performing_*`
   * candidates — a `creative_fatigue` claim makes no peer comparison. Absent
   * whenever no lesson survived the gate, so its presence IS the receipt that
   * the comparison ran and the value won it.
   */
  peer?: PerformanceFactPeerEvidence;
}

/**
 * The peer pool's curve, recorded so a level claim is auditable. On the default
 * `ctr`/`cpc` objective the numbers are the pool's CLICK curve and the shape is
 * byte-identical to pre-objective-layer. Under `roas`/`cpa` they are the pool's
 * OBJECTIVE curve (purchases per impression) and `objective` names the ruler —
 * the field names keep their spelling so no consumer has to branch.
 */
export interface PerformanceFactPeerEvidence {
  /** Pooled posterior mean of the dimension's OTHER values, on the active ruler. */
  clickMean: number;
  /** That pool's 95% band — the value's own band sat strictly above it. */
  clickCi95: [number, number];
  /** Real (non-borrowed) evidence behind the pool, in decayed impressions. */
  evidenceEss: number;
  /** How many other values of this dimension were pooled. */
  values: number;
  /** The ruler these numbers were measured on. ABSENT under the default `ctr`. */
  objective?: CreativeObjective;
}

// ── Workstream F — Rules of Life and Death (live-ad lifecycle evaluation) ────

/**
 * Overall verdict for one live engine-published ad on one sweep day.
 * `hold` is the explicit "checked, did nothing" receipt — every evaluation is
 * recorded, including the ones where the correct action was nothing.
 */
export type LifecycleVerdict = 'in_grace' | 'kill_proposed' | 'crown_proposed' | 'hold';

/**
 * The kill sub-test's outcome. `kill` requires CONFIDENCE, never a bad average:
 * the ad's whole Wilson band must sit well below the brand baseline's band
 * (`compareAdToBaseline`). Thin data widens the band and the math refuses.
 */
export type LifecycleKillVerdict =
  | 'kill'
  | 'not_significant'
  | 'insufficient_sample'
  | 'insufficient_baseline';

/**
 * The crown sub-test's outcome. Purchases only ever CROWN — no kill rule may
 * reference them (a large share of healthy ads show zero purchases; a
 * purchase-kill would execute the portfolio for being normal).
 */
export type LifecycleCrownVerdict =
  | 'crown'
  | 'under_crown_age'
  | 'below_median_ctr'
  | 'no_purchase'
  | 'insufficient_cohort';

/**
 * Every threshold the evaluator uses — resolved defaults → env → org settings
 * BEFORE the pure evaluator runs, and frozen verbatim into each evaluation row
 * so any past verdict can be audited against the exact numbers that decided it.
 */
export interface LifecycleThresholds {
  /** No verdict before this many days since `generated_creatives.published_at`. */
  graceMinAgeDays: number;
  /** No verdict below this many (scrubbed) impressions — the repo's settled 500. */
  minImpressions: number;
  /** The kill test's "well below" factor AT the impression floor (baseline CI lower bound). */
  killMarginRatio: number;
  /**
   * The asymptote the kill margin relaxes TOWARD as evidence accumulates
   * (`refresh-outcome.ts` `effectiveMarginRatio`). Must be ≥ `killMarginRatio`;
   * a merged value below it degrades to the constant margin. At `1` the rule
   * tends to a pure credible-difference test at infinite evidence instead of
   * stalling at `adCtr < killMarginRatio × baseCtr` forever.
   */
  killMarginRatioMax: number;
  /** Per-side floor for the baseline comparison (comparator `minImpressionsPerSide`). */
  baselineMinImpressions: number;
  /** Crown requires a longer life than grace — validated ≥ graceMinAgeDays. */
  crownMinAgeDays: number;
  /** Scrubbed purchases required to crown (≥ 1). */
  crownMinPurchases: number;
  /** Live peers (incl. self) required before "above-median" means anything. */
  crownMinPeers: number;
}

/**
 * CLICKS-ONLY evidence — the kill path's whole input universe. Purchase fields
 * are unrepresentable here BY TYPE; behavioral + structural tests fence it too.
 */
export interface ClickEvidence {
  impressions: number;
  clicks: number;
}

/** Live-status + account refs for one platform ad (resolved from the `ads` row). */
export interface AdLifecycleState {
  adId: string;
  adAccountId: string | null;
  campaignId: string | null;
  adSetId: string | null;
  /** `effective_status ?? status` through the ACTIVE/ENABLED rule. */
  isActive: boolean;
}

/** Which rung resolved the brand-normal CTR baseline. */
export type LifecycleBaselineSource = 'engine_cohort' | 'org_memory';

/**
 * The brand-normal snapshot an evaluation was judged against. `sums` records
 * whether the counts are raw (engine cohort) or decayed (org memory slice) so
 * the number is reproducible from its source.
 */
export interface LifecycleBaselineSnapshot {
  source: LifecycleBaselineSource;
  sums: 'raw' | 'decayed';
  impressions: number;
  clicks: number;
  ci: ProportionCI;
  /**
   * The baseline's purchase counts, present ONLY under a `roas`/`cpa`
   * objective — the kill rule's evidence on those rulers. Absent under the
   * default `ctr`/`cpc`, so the recorded payload (and the structural test that
   * pins "no purchase key reaches a CTR kill receipt") is unchanged.
   */
  purchases?: number;
  purchaseValue?: number;
}

/** The kill sub-test's full receipt (CIs present on every verdict). */
export interface LifecycleKillAssessment {
  verdict: LifecycleKillVerdict;
  adCI: ProportionCI;
  /** Null only when no baseline rung resolved (`insufficient_baseline`). */
  baselineCI: ProportionCI | null;
  /**
   * The margin ACTUALLY applied — the evidence-relaxed effective factor, not
   * necessarily `thresholds.killMarginRatio` (which is only its value at the
   * impression floor). `insufficient_baseline`/`insufficient_sample` record the
   * constant, since no relaxation was computed.
   */
  marginRatio: number;
  /**
   * The objective ruler and its per-side value scale, present ONLY under
   * `roas`/`cpa`. `adCI`/`baselineCI` remain the UNSCALED proportion intervals
   * (a `ProportionCI` is clamped to [0, 1] and must stay a rate); the margin
   * test applies each side's own scale to its bound, so this block is what
   * makes that comparison reproducible from the receipt alone.
   */
  objective?: ObjectiveKillScales;
}

/** The value scales a `roas`/`cpa` kill comparison applied to each side's bound. */
export interface ObjectiveKillScales {
  name: CreativeObjective;
  /** `roas` → the side's realized AOV; `cpa` → 1 (a purchase IS the unit). */
  adScale: number;
  baselineScale: number;
}

/** The crown sub-test's full receipt. */
export interface LifecycleCrownAssessment {
  verdict: LifecycleCrownVerdict;
  /** Live engine peers clearing the impression floor (incl. self). */
  peerCount: number;
  medianPeerCtr: number | null;
  adCtr: number | null;
}

/**
 * One ad's evaluation on one sweep day — the durable `engine_decisions.inputs`
 * payload. Carries the rule inputs, both sub-verdicts with their numbers, the
 * baseline snapshot, and the exact thresholds used.
 */
export interface LifecycleEvaluation {
  candidateId: string;
  adId: string;
  platform: string;
  adAccountId: string | null;
  campaignId: string | null;
  adSetId: string | null;
  /** Whole days since published_at at the injected asOf; null on legacy rows. */
  ageDays: number | null;
  sample: {
    impressions: number;
    clicks: number;
    /** Contamination-scrubbed purchases — the only purchases crown may count. */
    scrubbedPurchases: number;
    /** Pre-scrub purchases, recorded so the scrub's effect is visible. */
    rawPurchases: number;
    /**
     * Contamination-scrubbed purchase VALUE, present ONLY under a `roas`
     * objective (the one ruler that reads it). Absent otherwise, so a CTR
     * evaluation payload is byte-identical to pre-objective-layer.
     */
    scrubbedPurchaseValue?: number;
  };
  verdict: LifecycleVerdict;
  /** Null while in grace (the sub-tests never ran). */
  kill: LifecycleKillAssessment | null;
  crown: LifecycleCrownAssessment | null;
  baseline: LifecycleBaselineSnapshot | null;
  thresholds: LifecycleThresholds;
  /**
   * The ruler this evaluation was judged on. ABSENT under the default `ctr`,
   * so a default payload is byte-identical to pre-objective-layer. PRESENT for
   * `cpc` even though its ranking is `ctr`'s exactly: the org's CHOICE is what
   * an audit needs to see. See `loop/objective.ts`.
   */
  objective?: CreativeObjective;
}

/** The whole sweep-day evaluation pass for one org. */
export interface LifecycleEvaluationReport {
  evaluations: LifecycleEvaluation[];
  /** Engine-published candidates seen (the join population before the live filter). */
  published: number;
  /** Candidates whose platform ad is currently live (the evaluated population). */
  live: number;
  verdictCounts: Record<LifecycleVerdict, number>;
}

// ── Workstream G — the fence ─────────────────────────────────────────────────

/**
 * The engine's fence knobs. Resolved defaults → env → org settings BEFORE the
 * pure planner runs, and frozen verbatim into every decision row so any past
 * action can be audited against the exact numbers that decided it.
 */
export interface FenceThresholds {
  /** Concurrently-live engine ads allowed inside one platform's fence. */
  maxLiveAds: number;
  /** Observed-over-declared spend ratio that trips the circuit breaker (≥ 1). */
  capBreachRatio: number;
  /**
   * The retirement clock (`settings.creativeFence.retireAfterServedDays`):
   * pause an ad once it has SERVED this many days. The key is ABSENT when the
   * clock is off — which is the default and production's shipped behaviour —
   * rather than carried as an explicit null, so a fence without the clock
   * writes byte-for-byte the decision payload it always wrote.
   */
  retireAfterServedDays?: number;
}

/** Platforms the fence can act on. TikTok publish is unsupported, so it has no fence. */
export type FencePlatform = 'meta' | 'google';

/**
 * One platform's fence as the planner sees it — the declared ids plus the cap,
 * all in MAJOR currency units. `adSetId` is the Meta ad set / Google ad group.
 */
export interface ResolvedPlatformFence {
  platform: FencePlatform;
  adAccountId: string;
  campaignId: string;
  adSetId: string;
  dailyCapAmount: number;
}

/**
 * What the live platform read found. `dailyBudgetAmount` is normalized into
 * MAJOR units by the reader — the planner never sees cents or micros, which is
 * how the repo's most-repeated bug class (budget units) is fenced off here.
 */
export interface FencePlatformState {
  platform: FencePlatform;
  /** The leaf's parent campaign id as the PLATFORM reports it. */
  parentCampaignId: string | null;
  /** Daily budget in MAJOR units; null when the leaf carries no daily budget. */
  dailyBudgetAmount: number | null;
  /** True when the leaf carries a lifetime (not daily) budget — rejected. */
  hasLifetimeBudget: boolean;
  /** Leaf ids (ad sets / ad groups) under the declared campaign, for exclusivity. */
  siblingLeafIds: string[];
  /**
   * Whether the leaf can DELIVER right now: Meta `effective_status === 'ACTIVE'`
   * (which folds in a paused/archived parent), Google ad group AND campaign
   * both `ENABLED`. `null` = the platform did not report it — the planner
   * fails closed on null, never guesses. Added after the 2026-09-04 production
   * run found the ad set PAUSED while every other rung was green: activating
   * an ad under a paused parent "succeeds" on Meta and never delivers.
   */
  leafDeliveryActive: boolean | null;
  /** The raw platform word behind `leafDeliveryActive`, for the diary. */
  leafEffectiveStatus: string | null;
}

/** An ad the `ads` table says lives inside the fence leaf (engine-owned or not). */
export interface FenceResidentAd {
  adId: string;
  adAccountId: string | null;
  campaignId: string | null;
  adSetId: string | null;
  isActive: boolean;
  /** Spend on the evaluated day, org currency MAJOR units. */
  spend: number;
}

/**
 * Why a platform's fence refused to act. Recorded on EVERY affected ad, never
 * summarized away — "why did the machine do that" must always have an answer.
 */
export type FencePreflightFailure =
  | 'fence_not_configured'
  | 'fence_disabled'
  | 'fence_breach_unresolved'
  | 'fence_campaign_mismatch'
  | 'fence_not_delivering'
  | 'fence_campaign_not_exclusive'
  | 'fence_no_daily_budget'
  | 'fence_budget_exceeds_cap'
  | 'fence_contains_foreign_ads'
  | 'cap_breach';

/** The preflight verdict for one platform, with the numbers that produced it. */
export interface FencePreflightResult {
  platform: FencePlatform;
  ok: boolean;
  failure: FencePreflightFailure | null;
  /** Null when the fence is not configured (nothing was read). */
  fence: ResolvedPlatformFence | null;
  /** Platform-reported daily budget in MAJOR units, when read. */
  platformDailyBudget: number | null;
  /** The leaf's platform-reported delivery state, when read (e.g. `CAMPAIGN_PAUSED`). */
  leafEffectiveStatus: string | null;
  /** Fence-resident spend on the evaluated day, MAJOR units. */
  observedSpend: number;
  /** Non-engine ads found inside the fence leaf (the exclusivity breach). */
  foreignAdIds: string[];
}

/**
 * What the engine did — or would have done — to one ad on one sweep day.
 *
 * `activated`/`paused` are LIVE-mode outcomes; `would_activate`/`would_pause`
 * are their dry-run twins. Everything else is a recorded non-action, including
 * the plain `no_action` receipt ("checked, did nothing").
 *
 * `over_cap_shed` is the ONE pause that is neither F's kill nor the circuit
 * breaker — the surplus of a leaf that started over `maxLiveAds`. It keeps its
 * own verdict in live mode too (`circuit_broken` collapses to `paused`, this
 * does not), because `fetchPreviouslyKilledFenceAdIds` adopts `paused` /
 * `circuit_broken` into the never-re-activate set and a shed ad is NOT killed.
 *
 * `retired` is the retirement CLOCK's pause (`retireAfterServedDays`) and is
 * likewise its own verdict end-to-end: it keeps the spelling in live mode, the
 * kill-history read never adopts it, and `skipped_retired` — not
 * `skipped_previously_killed` — is what keeps a retired ad off the activation
 * queue forever. A retirement is NOT a kill and must never be counted as one:
 * the ad was rotated out for age, not condemned for performance, and a kill
 * rate that silently absorbed the clock would read as a loop that suddenly
 * started killing everything.
 */
export type FenceActionVerdict =
  | 'activated'
  | 'paused'
  | 'would_activate'
  | 'would_pause'
  | 'circuit_broken'
  | 'would_circuit_break'
  | 'over_cap_shed'
  | 'retired'
  | 'skipped_retired'
  | 'no_action'
  | 'skipped_slot_full'
  | 'skipped_previously_killed'
  | 'skipped_kill_proposed'
  | 'blocked_preflight'
  | 'failed';

/** The verb a decision carries, independent of whether it was applied. */
export type FenceActionVerb = 'activate' | 'pause' | 'none';

/** How the activation queue was ordered — recorded so a later change is visible. */
export type FenceActivationOrdering = 'published_at_fifo';

/** One ad's fence decision on one sweep day — the `engine_decisions.inputs` payload. */
export interface FenceDecision {
  candidateId: string | null;
  adId: string;
  platform: FencePlatform;
  adAccountId: string | null;
  campaignId: string | null;
  adSetId: string | null;
  /** Whole days since `published_at` at the injected asOf; null on legacy rows. */
  ageDays: number | null;
  verb: FenceActionVerb;
  verdict: FenceActionVerdict;
  /** True only when a platform call actually succeeded (never true in dry-run). */
  applied: boolean;
  /** Whether the ad was live at decision time, per `effective_status ?? status`. */
  wasActive: boolean;
  /** The preflight the decision was made under. */
  preflight: FencePreflightResult;
  /** F's verdict for this ad, when one existed — G never re-derives significance. */
  lifecycleVerdict: LifecycleVerdict | null;
  /** Slot accounting at decision time (live count vs the cap). */
  slots: { live: number; max: number } | null;
  /**
   * Distinct days this ad has SERVED (`ad_daily_metrics` rows with impressions
   * > 0) at decision time. Present ONLY on the retirement clock's own verdicts
   * — absent everywhere else, so a fence with the clock off keeps the exact
   * decision payload it wrote before the clock existed.
   */
  servedDays?: number;
  /** Ordering basis for an activation decision; null for pauses/non-actions. */
  ordering: FenceActivationOrdering | null;
  thresholds: FenceThresholds;
  /** Structured platform failure when `verdict === 'failed'`. */
  error: { code: string; reason: string } | null;
}

/** The whole sweep-day fence pass for one org, across every configured platform. */
export interface FenceActionPlan {
  decisions: FenceDecision[];
  preflight: FencePreflightResult[];
  /** Ads the planner intends to switch ON (live mode) — a subset of `decisions`. */
  activations: FenceDecision[];
  /** Ads the planner intends to switch OFF (live mode) — a subset of `decisions`. */
  pauses: FenceDecision[];
  /** Platforms whose circuit breaker tripped this sweep. */
  breachedPlatforms: Array<{ platform: FencePlatform; observedSpend: number; cap: number }>;
  verdictCounts: Record<FenceActionVerdict, number>;
}

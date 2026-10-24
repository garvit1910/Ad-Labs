/**
 * Experiment mode (Iterate vs Experiment) — shared wire/domain types.
 *
 * The cross-workstream contract for the Creative Studio experiment feature
 * (plan: tasks/creative-studio-experimentation-plan.md). Consumed by the
 * experiment source module, the strategy preview route, the briefs route,
 * the MCP tool, and (type-only) the composer UI.
 *
 * TYPES + CONST ARRAYS ONLY — no imports, no IO, client-safe. Adding a
 * value-level import here would leak server modules into client bundles
 * (the lib/accounts/token-health split class).
 */

export const GENERATION_MODES = ['iterate', 'experiment'] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

export const EXPERIMENT_OPPORTUNITY_KINDS = [
  'untested_angle',
  'open_territory',
] as const;
export type ExperimentOpportunityKind =
  (typeof EXPERIMENT_OPPORTUNITY_KINDS)[number];

/** Which Brand Identity computation produced the opportunity. */
export const EXPERIMENT_SOURCE_KINDS = [
  'alignment_gap',
  'territory_open',
  'strategy_alternate',
] as const;
export type ExperimentSourceKind = (typeof EXPERIMENT_SOURCE_KINDS)[number];

/**
 * Evidence line rendered on the opportunity card and recorded (slimmed) in
 * the brief stamp. `ownAdCount` is definitionally 0 for a true experiment —
 * kept explicit so the UI can say "you've run 0".
 */
export interface ExperimentOpportunityEvidence {
  competitorWinnerCount: number;
  competitorCount?: number;
  replicationWeight?: number;
  marketShare?: number;
  ownAdCount: number;
}

/**
 * One ranked, producibility-pre-filtered experiment opportunity.
 *
 * `angleKey` is the VERBATIM taxonomy angle value — the attribution key that
 * flows into performance_memory. Never rephrase it; prose reaches the
 * composer only via `directive` (deterministicAngleDirective(angleKey)).
 */
export interface ExperimentOpportunity {
  kind: ExperimentOpportunityKind;
  angleKey: string;
  /** Humanized display label for the card (slug → words). */
  angleLabel: string;
  /** Present for open_territory: the empty format cell to target. */
  format?: string;
  /** Deterministic prose directive derived from angleKey. */
  directive: string;
  sourceKind: ExperimentSourceKind;
  evidence: ExperimentOpportunityEvidence;
}

/**
 * What the client submits back on an experiment brief (compose.experiment).
 * Deliberately excludes evidence — the server stamps provenance from the
 * selection identity only; evidence numbers are re-derivable reads.
 */
export interface ExperimentSelection {
  kind: ExperimentOpportunityKind;
  angleKey: string;
  format?: string;
  sourceKind: ExperimentSourceKind;
}

/** Fatigued prior surfaced for the composer's nudge banner. */
export interface FatiguedPriorSummary {
  dimension: string;
  value: string;
}

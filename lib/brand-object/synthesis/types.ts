/**
 * Brand Object synthesis domain types — the Brand Identity page's AI Brand
 * Narrative ("The read").
 *
 * 4th instance of the canonical synthesis playbook (`lib/optimization/
 * synthesis/` → `lib/attribution/synthesis/` → here): the LLM never SOURCES a
 * number or a fact. The deterministic Layer-3 pipeline owns every figure —
 * the pack is built from the SAME pure insight selectors the dashboard
 * renders (`lib/brand-object/insights.ts`), and synthesis writes a short
 * strategic narrative in ONE model call.
 *
 * `watchItems`/`hypotheses` are non-actionable model observations —
 * deliberately never surfaced as approvable actions.
 */
import type { Locale } from '@/i18n/config';

/** Provenance of a synthesis run. Open for future triggers. */
export type BrandSynthesisTrigger = 'manual' | (string & {});

/** Terminal status of a synthesis row. */
export type BrandSynthesisStatus = 'ready' | 'skipped' | 'failed';

/** A narrated strength/tension grounded in pack numbers. */
export interface BrandSynthesisFinding {
  /** One-sentence point, quoting pack numbers verbatim. */
  point: string;
  /** The specific pack facts/numbers this rests on (human-readable). */
  evidence: string;
}

/** A non-actionable observation worth a human check. */
export interface BrandSynthesisWatchItem {
  observation: string;
  suggestedCheck: string;
}

/** A model-only hypothesis — never an approvable recommendation. */
export interface BrandSynthesisHypothesis {
  hypothesis: string;
  /** Which pack facts make it plausible. */
  groundedIn: string;
}

/** The parsed, validated LLM output. */
export interface BrandSynthesisContent {
  headline: string;
  /** 1–3 short narrative paragraphs. */
  story: string[];
  strengths: BrandSynthesisFinding[];
  tensions: BrandSynthesisFinding[];
  watchItems: BrandSynthesisWatchItem[];
  hypotheses: BrandSynthesisHypothesis[];
}

/** Token + (optional) dollar cost of a synthesis run. */
export interface BrandSynthesisCost {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** USD when `AGENT_EVAL_PRICING_JSON` prices the wire model; else null. */
  usd: number | null;
  model: string;
}

/** Structured error stamped on a failed synthesis. */
export interface BrandSynthesisError {
  code: string;
  reason: string;
}

/** Coverage snapshot recorded for reproducibility + staleness checks. */
export interface BrandSynthesisInputSnapshot {
  factsCount: number;
  perSectionCounts: Record<string, number>;
  completenessOverall: number | null;
  brandName: string | null;
  /**
   * Answer language when NOT English (i18n D10). Absent = English, so English rows
   * keep their pre-i18n shape. The cooldown keys on the locale-aware fingerprint.
   */
  locale?: Locale;
}

/** A synthesis row as read from the DB (camelCase, JSONB parsed). */
export interface BrandSynthesis {
  id: string;
  organizationId: string;
  brandProfileId: string;
  status: BrandSynthesisStatus;
  trigger: BrandSynthesisTrigger;
  headline: string | null;
  story: string[];
  strengths: BrandSynthesisFinding[];
  tensions: BrandSynthesisFinding[];
  watchItems: BrandSynthesisWatchItem[];
  hypotheses: BrandSynthesisHypothesis[];
  inputsFingerprint: string | null;
  factsCount: number;
  model: string | null;
  cost: BrandSynthesisCost | null;
  inputSnapshot: BrandSynthesisInputSnapshot | null;
  generatedBy: string | null;
  generatedByType: string | null;
  error: BrandSynthesisError | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The deterministic PACK handed to the single LLM call. Every entry is
 * pre-computed by the Layer-3 pipeline via the insight selectors; the model
 * quotes it verbatim (never invents a figure or a quote).
 */
export interface BrandSynthesisPack {
  organizationId: string;
  brandProfileId: string;
  brandName: string | null;
  category: string | null;
  asOfDate: string;
  /** Identity claims (positioning/value_prop/usp/proof_point) + voice. */
  identity: Array<{
    section: string;
    statement: string;
    confidence: number;
  }>;
  /** Top VOC rows per section — label, mentions, platforms, verbatim. */
  voc: Array<{
    section: string;
    label: string;
    mentions: number;
    platforms: Array<{ platform: string; count: number }>;
    verbatim: string | null;
  }>;
  /** Market priors — winner-gated, replication-weighted patterns. */
  market: Array<{
    dimension: string;
    value: string;
    conceptCount: number;
    replicationWeight: number;
    share: number;
  }>;
  personas: Array<{
    name: string;
    description: string;
    awarenessStage: string | null;
    /** True for the unaware projection — an extrapolation, not observed voice. */
    extrapolated: boolean;
    pains: string[];
    desires: string[];
  }>;
  compliance: string[];
  factsCount: number;
  perSectionCounts: Record<string, number>;
  completenessOverall: number | null;
}

/** Result of a synthesis run (returned by the service + route). */
export interface BrandSynthesisRunResult {
  synthesis: BrandSynthesis;
  /** True when an existing synthesis was returned (no fresh LLM call). */
  cooledDown: boolean;
}

/**
 * Staleness verdict at read time. Fingerprint-based: the stored synthesis's
 * inputs fingerprint vs one computed from the CURRENT live facts (a bounded
 * org+profile-scoped read the page already performs for the facts route).
 */
export interface BrandSynthesisStaleness {
  stale: boolean;
  reason: 'no_synthesis' | 'facts_changed' | 'fresh';
}

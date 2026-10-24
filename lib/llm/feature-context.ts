/**
 * Ambient LLM feature attribution (WS-1 of `tasks/llm-cost-optimization-plan.md`).
 *
 * Token accounting is only useful if a record can answer "which FEATURE spent
 * this?". Threading a `feature` param through every LLM call site would touch
 * ~40 modules, so instead the caller opens an `AsyncLocalStorage` scope once at
 * the top of a unit of work (a job processor run, later an interactive route)
 * and every `reportLlmUsage` inside that async tree stamps itself with it.
 *
 * Deliberately dependency-free and side-effect-free: it must be safe to import
 * from `lib/llm/clients/*`, which is loaded by essentially every server path.
 * Missing context is NOT an error — the record falls back to
 * `UNATTRIBUTED_FEATURE` so metering never depends on complete wiring.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface LlmFeatureContext {
  /** Stable, low-cardinality label (job type, route name, feature slug). */
  feature: string;
  /** Owning organization, when the work is org-scoped. */
  organizationId?: string | null;
}

/** Feature label used when a call runs outside any `runWithLlmContext` scope. */
export const UNATTRIBUTED_FEATURE = "unattributed";

/**
 * Feature labels for the interactive / cron entry points that are not queue jobs
 * (job-processor work is labelled with its job type). Shared so the writers and
 * any `llm_usage_daily` reader agree on the spelling.
 */
export const LLM_FEATURE = {
  /** Ask Adcero Agent Mode runs (`POST /api/ask-adcero/agent`), resumes included. */
  agentMode: "agent_mode",
  /** Legacy Ask Adcero chat (`POST /api/ask-adcero`). */
  askChat: "ask_chat",
  /** Daily Digest, per-org and agency roll-up (`/api/cron/agent-daily-digest`). */
  dailyDigest: "daily_digest",
} as const;

/** Guard against an unbounded `feature` column from an unexpected caller. */
const MAX_FEATURE_LENGTH = 120;

const storage = new AsyncLocalStorage<LlmFeatureContext>();

function normalizeFeature(feature: string | undefined): string {
  const trimmed = typeof feature === "string" ? feature.trim() : "";
  if (!trimmed) return UNATTRIBUTED_FEATURE;
  return trimmed.slice(0, MAX_FEATURE_LENGTH);
}

/**
 * Run `fn` with an ambient LLM attribution context. Nested scopes fully
 * replace the outer one (the innermost unit of work is the truthful owner).
 */
export function runWithLlmContext<T>(
  context: LlmFeatureContext,
  fn: () => T,
): T {
  return storage.run(
    {
      feature: normalizeFeature(context.feature),
      organizationId: context.organizationId ?? null,
    },
    fn,
  );
}

/** The active context, or `undefined` outside any scope. Never throws. */
export function getLlmContext(): LlmFeatureContext | undefined {
  try {
    return storage.getStore();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the attribution pair for a usage record. `fallbackFeature` lets a
 * call site that KNOWS its feature (e.g. the image providers, which are never
 * reached from anywhere else) stay attributed even with no ambient scope.
 */
export function resolveLlmAttribution(fallbackFeature?: string): {
  feature: string;
  organizationId: string | null;
} {
  const ctx = getLlmContext();
  if (ctx) {
    return {
      feature: ctx.feature || normalizeFeature(fallbackFeature),
      organizationId: ctx.organizationId ?? null,
    };
  }
  return { feature: normalizeFeature(fallbackFeature), organizationId: null };
}

import { resolveLlmAttribution } from "../feature-context";
import type { JsonRecord } from "./types";

/**
 * LLM usage observer (cost metering + eval token accounting). The sink is a
 * single process-wide slot: when none is registered `reportLlmUsage` is a
 * no-op, so a bare import costs nothing.
 *
 * TWO consumers register here:
 *  - PRODUCTION: `lib/observability/llm-metering.ts`, wired at server startup
 *    from `instrumentation.ts` (kill switch `LLM_USAGE_METERING=0`). It rolls
 *    each record into `llm_usage_daily` per day × feature × model × api × org.
 *  - EVALS: `startUsageMeter` in `lib/agent/evals/usage-meter.ts` totals tokens
 *    across a live run. It SAVES the previous sink and chains to it, so an eval
 *    meter running inside a metered server COMPOSES instead of clobbering.
 *
 * Metering must NEVER break or delay a real provider call — every function here
 * swallows its own errors and the production sink is fire-and-forget.
 */
export type LlmUsageApi = "responses" | "chat" | "gemini" | "images" | "jev";

export interface LlmUsageRecord {
  api: LlmUsageApi;
  model: string;
  inputTokens: number;
  /** Cached prompt tokens — a SUBSET of `inputTokens` (billed at a discount). */
  cachedInputTokens: number;
  outputTokens: number;
  /** Reasoning tokens — a SUBSET of `outputTokens` (do not add to the total). */
  reasoningTokens: number;
  /** Ambient feature label (`unattributed` outside a `runWithLlmContext`). */
  feature?: string;
  /** Owning organization when the ambient context declared one. */
  organizationId?: string | null;
}

type LlmUsageSinkFn = (_record: LlmUsageRecord) => void;

/**
 * The sink slot lives on `globalThis`, NOT in a module-level `let`.
 *
 * Next.js compiles `instrumentation.ts` in its own module layer: the local
 * production build showed this file under TWO module ids —
 * `lib/llm/clients/usage.ts [instrumentation]` and `... [app-route]` — which
 * are separate module instances with separate module-level state. The
 * metering sink registered at startup landed in the `[instrumentation]`
 * instance while every route handler and job processor called
 * `reportLlmUsage` on the `[app-route]` instance, whose slot was still null.
 * Result: `llm_usage_daily` stayed EMPTY in dev and prod for months with no
 * error (2026-09-28). A `Symbol.for` key on `globalThis` is shared by every
 * module instance in the process; that is the fix, and the regression test
 * (`tests/unit/lib/llm/usage-sink-global.test.ts`) imports two instances.
 */
const LLM_USAGE_SINK_KEY = Symbol.for("adcero.llm.usageSink");

type SinkHolder = { [LLM_USAGE_SINK_KEY]?: LlmUsageSinkFn | null };

function slot(): SinkHolder {
  return globalThis as unknown as SinkHolder;
}

/** Register (or clear, with `null`) the process-wide usage sink. */
export function setLlmUsageSink(sink: LlmUsageSinkFn | null): void {
  slot()[LLM_USAGE_SINK_KEY] = sink;
}

/**
 * Read the current usage sink. A nested meter saves this and chains to it so two
 * meters (an outer whole-run meter + an inner per-arm meter) COMPOSE instead of the
 * inner clobbering the outer — see `startUsageMeter` in `lib/agent/evals/usage-meter.ts`.
 */
export function getLlmUsageSink(): LlmUsageSinkFn | null {
  return slot()[LLM_USAGE_SINK_KEY] ?? null;
}

function usageNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Stamp the ambient feature/org onto a record and hand it to the sink. The only
 * place a record reaches the sink — keeps attribution impossible to forget.
 */
function emit(
  base: Omit<LlmUsageRecord, "feature" | "organizationId">,
  fallbackFeature?: string,
): void {
  const sink = getLlmUsageSink();
  if (!sink) return;
  try {
    const { feature, organizationId } = resolveLlmAttribution(fallbackFeature);
    sink({ ...base, feature, organizationId });
  } catch {
    // metering must never break a provider call
  }
}

/** OpenAI Responses / Chat Completions usage block → one usage record. */
export function reportLlmUsage(
  api: "responses" | "chat",
  body: JsonRecord,
  parsed: JsonRecord,
): void {
  if (!getLlmUsageSink()) return;
  try {
    const u = record(parsed?.usage);
    const model = typeof body?.model === "string" ? (body.model as string) : "unknown";
    if (api === "responses") {
      const outputDetails = record(u.output_tokens_details);
      const inputDetails = record(u.input_tokens_details);
      emit({
        api,
        model,
        inputTokens: usageNumber(u.input_tokens),
        cachedInputTokens: usageNumber(inputDetails.cached_tokens),
        outputTokens: usageNumber(u.output_tokens),
        reasoningTokens: usageNumber(outputDetails.reasoning_tokens),
      });
    } else {
      const promptDetails = record(u.prompt_tokens_details);
      emit({
        api,
        model,
        inputTokens: usageNumber(u.prompt_tokens),
        cachedInputTokens: usageNumber(promptDetails.cached_tokens),
        outputTokens: usageNumber(u.completion_tokens),
        reasoningTokens: 0,
      });
    }
  } catch {
    // metering must never break a provider call
  }
}

/**
 * Gemini `generateContent` usage. The `@google/genai` response carries
 * `usageMetadata.{promptTokenCount, candidatesTokenCount, cachedContentTokenCount,
 * thoughtsTokenCount}` (field names read from the SDK's own type declarations).
 * `cachedContentTokenCount` is a subset of `promptTokenCount`; `thoughtsTokenCount`
 * is Gemini's reasoning leg, mapped onto `reasoningTokens`.
 */
export function reportGeminiUsage(model: string, usageMetadata: unknown): void {
  if (!getLlmUsageSink()) return;
  try {
    const u = record(usageMetadata);
    emit({
      api: "gemini",
      model: model || "unknown",
      inputTokens: usageNumber(u.promptTokenCount),
      cachedInputTokens: usageNumber(u.cachedContentTokenCount),
      outputTokens: usageNumber(u.candidatesTokenCount),
      reasoningTokens: usageNumber(u.thoughtsTokenCount),
    });
  } catch {
    // metering must never break a provider call
  }
}

/**
 * TypeSafe Jev `POST /v1/systemone` usage (`usage.{input_tokens,output_tokens}`).
 * Output tokens are free at list price but are still recorded so call shape is
 * visible; Jev has no cached-input or reasoning legs.
 */
export function reportJevUsage(model: string, usage: unknown): void {
  if (!getLlmUsageSink()) return;
  try {
    const u = record(usage);
    emit({
      api: "jev",
      model: model || "unknown",
      inputTokens: usageNumber(u.input_tokens),
      cachedInputTokens: 0,
      outputTokens: usageNumber(u.output_tokens),
      reasoningTokens: 0,
    });
  } catch {
    // metering must never break a provider call
  }
}

/**
 * Image-generation call (OpenAI `gpt-image-*` / Gemini image models). These
 * providers bypass `lib/llm/clients` entirely, so the CALL COUNT is the primary
 * signal — image billing is per-image, not per-token. Tokens are recorded only
 * when the response actually carries a usage block (gpt-image responses may
 * include `usage.{input_tokens,output_tokens}`; Gemini returns `usageMetadata`),
 * never fabricated.
 */
export function reportImageUsage(
  model: string,
  usage?: unknown,
  fallbackFeature = "creative_image",
): void {
  if (!getLlmUsageSink()) return;
  try {
    const u = record(usage);
    const inputDetails = record(u.input_tokens_details);
    emit(
      {
        api: "images",
        model: model || "unknown",
        // Accept BOTH wire shapes: OpenAI (`input_tokens`) and Gemini
        // (`promptTokenCount`), so one helper serves both providers.
        inputTokens: usageNumber(u.input_tokens) || usageNumber(u.promptTokenCount),
        cachedInputTokens:
          usageNumber(inputDetails.cached_tokens) || usageNumber(u.cachedContentTokenCount),
        outputTokens: usageNumber(u.output_tokens) || usageNumber(u.candidatesTokenCount),
        reasoningTokens: 0,
      },
      fallbackFeature,
    );
  } catch {
    // metering must never break a provider call
  }
}

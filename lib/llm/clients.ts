/**
 * Ad Lab same-path stub for Adcero's `lib/llm/clients` barrel (REUSE_MANIFEST §8.2).
 *
 * Plain `fetch` to OpenAI with Adcero's semantics from `clients/openai.ts`:
 * the same error classes, inline retries, request timeout and flex-tier
 * downgrade. Usage metering is dropped (no copied file installs a sink).
 */
import { bodyUsesFlexTier, stripServiceTier } from "./flex";
import { LlmProviderError, QUOTA_RETRY_DELAY_MS } from "./errors";
import type { JsonRecord, LlmRetryProfile } from "./clients/types";

export type { LlmRetryProfile } from "./clients/types";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

interface OpenAIRequestParams {
  body: JsonRecord;
  apiKey?: string;
  signal?: AbortSignal;
  retryProfile?: LlmRetryProfile;
  attempts?: number;
  timeoutMs?: number;
}

export async function openAIChatCompletion(
  params: OpenAIRequestParams & { baseUrl?: string },
): Promise<JsonRecord> {
  return runOpenAIRequest("chat/completions", params);
}

export async function openAIEmbeddings(params: OpenAIRequestParams): Promise<JsonRecord> {
  return runOpenAIRequest("embeddings", params);
}

async function runOpenAIRequest(
  path: string,
  params: OpenAIRequestParams & { baseUrl?: string },
): Promise<JsonRecord> {
  // A custom base URL never falls back to the OpenAI key.
  const apiKey = params.baseUrl ? params.apiKey : params.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new LlmProviderError({
      provider: "openai",
      code: "OPENAI_API_KEY_NOT_CONFIGURED",
      reason: "OpenAI API key is not configured",
      remediation: "Configure OPENAI_API_KEY so queued jobs can retry later.",
      retryable: true,
      status: 500,
    });
  }
  const url = `${(params.baseUrl ?? OPENAI_BASE_URL).replace(/\/$/, "")}/${path}`;
  const timeoutMs = resolveRequestTimeoutMs(params.timeoutMs);
  const attempts = params.retryProfile === "interactive" ? 1 : Math.max(1, params.attempts ?? 2);

  // Latches to the standard-tier body once flex capacity fails, so a later
  // retry never re-probes flex.
  let body = params.body;
  for (let attempt = 1; ; attempt++) {
    try {
      try {
        return await postJson(url, apiKey, body, params.signal, timeoutMs);
      } catch (error) {
        if (!bodyUsesFlexTier(body) || !isFlexCapacityFailure(error)) throw error;
        body = stripServiceTier(body);
        return await postJson(url, apiKey, body, params.signal, timeoutMs);
      }
    } catch (error) {
      const retry =
        attempt < attempts &&
        error instanceof LlmProviderError &&
        error.retryable &&
        error.code !== "OPENAI_INSUFFICIENT_QUOTA";
      if (!retry) throw error;
      await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs ?? 500));
    }
  }
}

async function postJson(
  url: string,
  apiKey: string,
  body: JsonRecord,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<JsonRecord> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    if (timeoutSignal.aborted) {
      throw new LlmProviderError({
        provider: "openai",
        code: "OPENAI_REQUEST_TIMEOUT",
        reason: `OpenAI request exceeded ${timeoutMs}ms`,
        remediation: "The provider stalled; retry or let the queued job retry later.",
        retryable: true,
        status: 504,
        cause: error,
      });
    }
    throw new LlmProviderError({
      provider: "openai",
      code: "OPENAI_NETWORK_ERROR",
      reason: `OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation: "Check network connectivity, then let the queued job retry later.",
      retryable: true,
      status: 503,
      cause: error,
    });
  }

  const rawText = await response.text();
  if (!response.ok) throw classifyResponse(response, rawText);
  return JSON.parse(rawText) as JsonRecord;
}

function classifyResponse(response: Response, rawText: string): LlmProviderError {
  const status = response.status;
  const retryable = RETRYABLE_STATUSES.has(status);
  const insufficientQuota = status === 429 && /insufficient_quota/i.test(rawText);
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  return new LlmProviderError({
    provider: "openai",
    code: insufficientQuota
      ? "OPENAI_INSUFFICIENT_QUOTA"
      : retryable
        ? "OPENAI_TEMPORARY_FAILURE"
        : "OPENAI_REQUEST_FAILED",
    reason: `OpenAI request failed (${status}): ${rawText.trim().slice(0, 500) || "Unknown error"}`,
    remediation: insufficientQuota
      ? "Check OpenAI billing and quota, then let the queued job retry later."
      : retryable
        ? "Retry after the provider recovers or let the queued job retry later."
        : "Fix the request or provider configuration before retrying.",
    retryable,
    status,
    retryAfterMs: insufficientQuota ? retryAfterMs || QUOTA_RETRY_DELAY_MS : retryAfterMs,
  });
}

/** A flex request that found no flex capacity: 429 resource_unavailable, 408, or our timeout. */
function isFlexCapacityFailure(error: unknown): boolean {
  if (!(error instanceof LlmProviderError)) return false;
  if (error.code === "OPENAI_REQUEST_TIMEOUT" || error.status === 408) return true;
  return error.status === 429 && /resource_unavailable/i.test(error.message);
}

function resolveRequestTimeoutMs(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const env = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_REQUEST_TIMEOUT_MS;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

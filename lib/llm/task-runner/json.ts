import { LlmProviderError } from "../errors";
import type { JsonRecord } from "./types";

export function getFirstChatMessageContent(
  response: JsonRecord,
  fallback: string,
): string {
  const choices = response.choices as
    | Array<{ message?: { content?: string } }>
    | undefined;

  return choices?.[0]?.message?.content ?? fallback;
}

export function parseJsonObject(raw: string): JsonRecord {
  try {
    return JSON.parse(raw) as JsonRecord;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as JsonRecord;
      } catch {
        // Fall through to the retryable parse error below.
      }
    }

    // A malformed model response is transient: an immediate re-generation almost
    // always returns valid JSON. Surface it as a retryable LlmProviderError so
    // callers (e.g. /api/generate-ad-copy) queue a durable retry instead of
    // returning a hard 500. Mirrors createOpenAIStreamParseError in clients.ts.
    throw new LlmProviderError({
      provider: "llm",
      code: "MODEL_RESPONSE_PARSE_FAILED",
      reason: "Failed to parse model response as JSON",
      remediation:
        "Retry after the provider recovers or let the queued job retry later.",
      retryable: true,
      status: 503,
    });
  }
}

export function extractJsonFromModelText(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : text;
}

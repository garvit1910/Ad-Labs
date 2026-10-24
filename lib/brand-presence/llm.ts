import { modelForRole } from '@/lib/llm/model-roles';
/**
 * Shared bits for Brand Presence LLM calls. Every call site uses a strict
 * `json_schema` response_format (the label-processor pattern) — never
 * free-text JSON parsing — plus zod validation of the decoded payload.
 */

/** Cheap, fast model; override with BRAND_PRESENCE_LLM_MODEL. */
export function getBrandPresenceModel(): string {
  return modelForRole('brand_presence');
}

/** Wraps a schema object in the strict json_schema response_format shape. */
export function strictResponseFormat(
  name: string,
  schema: Record<string, unknown>,
) {
  return {
    type: 'json_schema',
    json_schema: { name, strict: true, schema },
  } as const;
}

/** Extracts + JSON-decodes the first chat message, throwing on absence. */
export function decodeChatJson(completion: unknown): unknown {
  const content = (
    completion as { choices?: Array<{ message?: { content?: string } }> }
  ).choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM response had no content');
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `LLM response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

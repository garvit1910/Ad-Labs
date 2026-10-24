/**
 * Shared types for the LLM provider clients.
 *
 * `JsonRecord` is the wire shape passed to/returned from the OpenAI HTTP APIs;
 * the rest model the streaming-chunk surface that Chat Completions consumers read.
 */
export type JsonRecord = Record<string, unknown>;

export type LlmRetryProfile = "background" | "interactive";

export interface OpenAIStreamToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIChatCompletionStreamChunk {
  contentDeltas: string[];
  toolCallDeltas: OpenAIStreamToolCallDelta[];
}

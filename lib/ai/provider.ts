/**
 * LLM Provider Abstraction
 *
 * Swappable provider interface so the codebase isn't locked to OpenAI.
 * To add a new provider: implement LLMProvider and register it in PROVIDERS.
 */

import { openAIChatCompletion } from "@/lib/llm/clients";
import { LlmProviderError } from "@/lib/llm/errors";
import { OPENAI_PROVIDER_FALLBACK_MODEL } from '@/lib/llm/model-roles';

// ─── Interface ──────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  abortSignal?: AbortSignal;
}

export interface LLMProvider {
  id: string;
  name: string;
  complete(_messages: LLMMessage[], _options?: LLMCompletionOptions): Promise<string>;
}

// ─── OpenAI Provider ────────────────────────────────────────────────

function createOpenAIProvider(apiKey: string): LLMProvider {
  return {
    id: 'openai',
    name: 'OpenAI',
    async complete(messages, options = {}) {
      const {
        model = OPENAI_PROVIDER_FALLBACK_MODEL,
        temperature = 0.7,
        maxTokens = 1024,
        jsonMode = false,
        abortSignal,
      } = options;

      const response = await openAIChatCompletion({
        apiKey,
        signal: abortSignal,
        body: {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(jsonMode && { response_format: { type: 'json_object' } }),
        },
      });

      return (
        (response.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]
          ?.message?.content ?? ''
      );
    },
  };
}

// ─── Provider Registry ──────────────────────────────────────────────

type ProviderFactory = (_apiKey: string) => LLMProvider;

const PROVIDERS: Record<string, ProviderFactory> = {
  openai: createOpenAIProvider,
  // Future: anthropic, google, mistral, etc.
};

/**
 * Get an LLM provider instance.
 *
 * @param providerId - Which provider to use (default: 'openai')
 * @param apiKey - API key override. If omitted, reads from env.
 */
export function getLLMProvider(providerId = 'openai', apiKey?: string): LLMProvider {
  const factory = PROVIDERS[providerId];
  if (!factory) {
    throw new Error(`Unknown LLM provider: "${providerId}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const key = apiKey ?? getEnvKey(providerId);
  if (!key) {
    throw new LlmProviderError({
      provider: providerId,
      code: "LLM_API_KEY_NOT_CONFIGURED",
      reason: `No API key found for provider "${providerId}". Set the corresponding env var.`,
      remediation: "Configure the provider API key so queued work can retry later.",
      retryable: true,
      status: 500,
    });
  }

  return factory(key);
}

function getEnvKey(providerId: string): string | undefined {
  const envMap: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    // Future: anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_AI_KEY', etc.
  };
  const envVar = envMap[providerId];
  return envVar ? process.env[envVar] : undefined;
}

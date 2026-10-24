/**
 * Theme labeling LLM step (pure — no DB): many clusters per structured call
 * on the cheap model, each getting a short label + 1-2 sentence summary from
 * its representative member paraphrases. Malformed/unknown keys fall back to
 * a truncated representative — a theme is never blocked on labeling.
 */
import { z } from 'zod';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import { decodeChatJson, getBrandPresenceModel, strictResponseFormat } from './llm';
import type { ThemeKind } from './types';

export interface ThemeToLabel {
  /** Caller-assigned batch-local key, echoed back by the model. */
  cluster_key: string;
  kind: ThemeKind;
  /** Representative member paraphrases. */
  phrases: string[];
}

export interface ThemeLabel {
  cluster_key: string;
  label: string;
  summary: string;
}

const labelItemSchema = z.object({
  cluster_key: z.string().min(1),
  label: z.string().min(1),
  summary: z.string(),
});

const labelResponseSchema = z.object({
  labels: z.array(z.unknown()),
});

const RESPONSE_FORMAT = strictResponseFormat('theme_labels', {
  type: 'object',
  additionalProperties: false,
  required: ['labels'],
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cluster_key', 'label', 'summary'],
        properties: {
          cluster_key: { type: 'string' },
          label: {
            type: 'string',
            description:
              'Theme name, <=6 words, concrete and specific (e.g. "Shipping damage", "Too sweet for adults")',
          },
          summary: {
            type: 'string',
            description:
              '1-2 sentences (<=160 chars) describing what customers say in this theme',
          },
        },
      },
    },
  },
});

const SYSTEM_PROMPT = `You name voice-of-customer themes. Each cluster below is a group of similar signals customers expressed about a brand/category (kind = pain, desire, objection, or praise). For each cluster return:
- label: a concrete theme name, <=6 words, specific enough to act on ("Shipping damage", "Wants more flavor variety" — never vague fillers like "Various issues").
- summary: 1-2 sentences (<=160 chars) describing what customers are saying.
Return every cluster_key exactly as given. Return STRICT JSON.`;

/** One structured call per batch; caller chunks to the config batch size. */
export async function labelThemes(
  themes: ThemeToLabel[],
  opts: { signal?: AbortSignal } = {},
): Promise<Map<string, ThemeLabel>> {
  if (themes.length === 0) return new Map();
  const completion = await openAIChatCompletion({
    body: {
      model: getBrandPresenceModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Name these ${themes.length} clusters:\n${JSON.stringify(themes, null, 2)}`,
        },
      ],
      response_format: RESPONSE_FORMAT,
      temperature: 0.2,
      // Queue job, no human waiting → Flex tier (50% off).
      ...flexServiceTier(),
    },
    signal: opts.signal,
    retryProfile: 'background',
  });

  const parsed = labelResponseSchema.parse(decodeChatJson(completion));
  const knownKeys = new Set(themes.map((theme) => theme.cluster_key));
  const labels = new Map<string, ThemeLabel>();
  for (const rawItem of parsed.labels) {
    const item = labelItemSchema.safeParse(rawItem);
    if (!item.success) continue;
    if (!knownKeys.has(item.data.cluster_key)) continue;
    labels.set(item.data.cluster_key, {
      cluster_key: item.data.cluster_key,
      label: item.data.label.slice(0, 80),
      summary: item.data.summary.slice(0, 300),
    });
  }
  return labels;
}

/**
 * Small-corpus direct LLM grouping (pure — no DB): when a (kind × scope)
 * partition has too few phrases for embedding clustering to be worth it, ONE
 * cheap-model call groups them by meaning and names each group in the same
 * pass (so these groups skip the labelThemes batch). The model's indexes are
 * never trusted: out-of-range indexes drop, duplicates resolve first-group-
 * wins, groups that shrink below 2 dissolve, and unassigned phrases are the
 * caller's catch-all. THROWS on LLM/parse failure — the cluster processor
 * catches and falls back to the embedding path (vectors always exist).
 */
import { z } from 'zod';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import { decodeChatJson, getBrandPresenceModel, strictResponseFormat } from './llm';
import type { PhraseScope, ThemeKind } from './types';

export interface PhraseToGroup {
  /** Caller-assigned partition-local index, echoed back by the model. */
  index: number;
  /** Paraphrase (fallback: raw phrase). */
  text: string;
}

export interface LlmPhraseGroup {
  label: string;
  summary: string;
  /** Validated, deduped indexes into the caller's phrase list. */
  phraseIndexes: number[];
}

const groupItemSchema = z.object({
  label: z.string().min(1),
  summary: z.string(),
  phrase_indexes: z.array(z.number()),
});

const groupResponseSchema = z.object({
  groups: z.array(z.unknown()),
});

const RESPONSE_FORMAT = strictResponseFormat('phrase_groups', {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'summary', 'phrase_indexes'],
        properties: {
          label: {
            type: 'string',
            description:
              'Theme name, <=6 words, concrete and specific (e.g. "Feels overpriced", "Bad aftertaste")',
          },
          summary: {
            type: 'string',
            description:
              '1-2 sentences (<=160 chars) describing what customers say in this theme',
          },
          phrase_indexes: {
            type: 'array',
            items: { type: 'integer' },
            description: 'The i values of the signals in this theme',
          },
        },
      },
    },
  },
});

function buildSystemPrompt(kind: ThemeKind): string {
  return `You group voice-of-customer signals into themes. Below are short ${kind} signals customers expressed about a brand/category. Group signals that express the SAME underlying theme (e.g. "too expensive" + "overpriced for what you get" = one theme).
Rules:
- Every group needs at least 2 signals. Leave a signal out of "groups" entirely when nothing else expresses the same theme — do NOT force unrelated signals together and do NOT create one-signal groups.
- A signal belongs to at most one group.
- label: a concrete theme name, <=6 words, specific enough to act on ("Feels overpriced", "Bad aftertaste" — never vague fillers like "Various issues").
- summary: 1-2 sentences (<=160 chars) describing what customers are saying.
Return STRICT JSON.`;
}

/** One structured call grouping a small partition's phrases by meaning. */
export async function groupPhrases(
  kind: ThemeKind,
  _scope: PhraseScope,
  phrases: PhraseToGroup[],
  opts: { signal?: AbortSignal } = {},
): Promise<LlmPhraseGroup[]> {
  if (phrases.length === 0) return [];
  const completion = await openAIChatCompletion({
    body: {
      model: getBrandPresenceModel(),
      messages: [
        { role: 'system', content: buildSystemPrompt(kind) },
        {
          role: 'user',
          content: `Group these ${phrases.length} ${kind} signals:\n${JSON.stringify(
            phrases.map((phrase) => ({ i: phrase.index, text: phrase.text })),
            null,
            2,
          )}`,
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

  const parsed = groupResponseSchema.parse(decodeChatJson(completion));
  const validIndexes = new Set(phrases.map((phrase) => phrase.index));
  const seen = new Set<number>();
  const groups: LlmPhraseGroup[] = [];
  for (const rawItem of parsed.groups) {
    const item = groupItemSchema.safeParse(rawItem);
    if (!item.success) continue;
    const phraseIndexes: number[] = [];
    for (const index of item.data.phrase_indexes) {
      if (!Number.isInteger(index)) continue;
      if (!validIndexes.has(index)) continue;
      if (seen.has(index)) continue; // duplicate across groups — first wins
      seen.add(index);
      phraseIndexes.push(index);
    }
    // A group that shrank below 2 valid members dissolves; release its
    // claimed indexes back to unassigned (the caller's catch-all pool).
    if (phraseIndexes.length < 2) {
      for (const index of phraseIndexes) seen.delete(index);
      continue;
    }
    groups.push({
      label: item.data.label.slice(0, 80),
      summary: item.data.summary.slice(0, 300),
      phraseIndexes,
    });
  }
  return groups;
}

/**
 * Post-label synonym-merge refinement (pure LLM + pure math, no DB): after
 * embedding-path angles are labeled, one cheap-model call per partition asks
 * which angles describe the SAME customer theme (embeddings sometimes leave
 * true synonyms — "Feels overpriced" / "Not worth the money" — just under the
 * merge threshold). Best-effort by design: invalid/unknown/self/conflicting
 * keys drop, and any LLM failure returns no merges so the run never blocks.
 */
import { z } from 'zod';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import { decodeChatJson, getBrandPresenceModel, strictResponseFormat } from './llm';
import {
  draftFrom,
  type PhraseForClustering,
  type ThemeDraft,
} from './themes';
import type { ThemeKind } from './types';

export interface ThemeForMerge {
  /** Caller-assigned key (draft index), echoed back by the model. */
  key: string;
  label: string;
  /** Representative member paraphrases. */
  phrases: string[];
}

const mergeItemSchema = z.object({
  into: z.string().min(1),
  absorb: z.array(z.string()),
});

const mergeResponseSchema = z.object({
  merges: z.array(z.unknown()),
});

const RESPONSE_FORMAT = strictResponseFormat('theme_merges', {
  type: 'object',
  additionalProperties: false,
  required: ['merges'],
  properties: {
    merges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['into', 'absorb'],
        properties: {
          into: {
            type: 'string',
            description: 'key of the theme that keeps its label',
          },
          absorb: {
            type: 'array',
            items: { type: 'string' },
            description: 'keys of synonymous themes merged into it',
          },
        },
      },
    },
  },
});

const SYSTEM_PROMPT = `You deduplicate voice-of-customer themes. Below are labeled themes of the same kind, each with sample customer signals. Report which themes describe the SAME underlying customer theme (true synonyms or rephrasings — e.g. "Feels overpriced" and "Not worth the money").
Rules:
- Only merge true synonyms. Related-but-distinct themes ("Bad flavor" vs "Bad aftertaste") stay separate. When in doubt, do NOT merge.
- "into" is the theme whose label best covers the merged group; "absorb" lists the themes folded into it.
- Themes not part of any merge are simply omitted. An empty merges array is a valid answer.
Return STRICT JSON.`;

/**
 * One structured call per partition proposing synonym merges. Returns
 * absorbedKey -> canonicalKey. Never throws — failure means no merges.
 */
export async function proposeThemeMerges(
  kind: ThemeKind,
  themes: ThemeForMerge[],
  opts: { signal?: AbortSignal } = {},
): Promise<Map<string, string>> {
  if (themes.length < 2) return new Map();
  let parsed: z.infer<typeof mergeResponseSchema>;
  try {
    const completion = await openAIChatCompletion({
      body: {
        model: getBrandPresenceModel(),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Deduplicate these ${themes.length} ${kind} themes:\n${JSON.stringify(themes, null, 2)}`,
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
    parsed = mergeResponseSchema.parse(decodeChatJson(completion));
  } catch (error) {
    console.warn(
      `[BrandPresence] theme merge pass failed for kind=${kind}, keeping unmerged themes`,
      error,
    );
    return new Map();
  }

  const knownKeys = new Set(themes.map((theme) => theme.key));
  const merges = new Map<string, string>(); // absorbedKey -> canonicalKey
  const canonicals = new Set<string>();
  for (const rawItem of parsed.merges) {
    const item = mergeItemSchema.safeParse(rawItem);
    if (!item.success) continue;
    const into = item.data.into;
    // A canonical that was itself absorbed earlier is a conflict — drop.
    if (!knownKeys.has(into) || merges.has(into)) continue;
    for (const absorbed of item.data.absorb) {
      if (!knownKeys.has(absorbed)) continue;
      if (absorbed === into) continue;
      // Already absorbed elsewhere, or used as a canonical — drop (no chains).
      if (merges.has(absorbed) || canonicals.has(absorbed)) continue;
      merges.set(absorbed, into);
      canonicals.add(into);
    }
  }
  return merges;
}

/**
 * Applies merge instructions: unions member lists into the canonical draft,
 * re-derives its math via draftFrom (centroid/representatives/counts), and
 * keeps the canonical label/summary. Keys are draft indexes as strings —
 * the same keys handed to proposeThemeMerges. Pure.
 */
export function applyThemeMerges(
  drafts: ThemeDraft[],
  merges: Map<string, string>,
  phraseById: Map<string, PhraseForClustering>,
  config: { representativeCount: number },
): ThemeDraft[] {
  if (merges.size === 0) return drafts;
  const absorbedInto = new Map<number, number>();
  for (const [absorbedKey, canonicalKey] of merges) {
    const absorbed = Number(absorbedKey);
    const canonical = Number(canonicalKey);
    if (
      !Number.isInteger(absorbed) ||
      !Number.isInteger(canonical) ||
      drafts[absorbed] === undefined ||
      drafts[canonical] === undefined
    ) {
      continue;
    }
    absorbedInto.set(absorbed, canonical);
  }
  if (absorbedInto.size === 0) return drafts;

  const memberIdsByDraft = drafts.map((draft) => [...draft.phraseIds]);
  for (const [absorbed, canonical] of absorbedInto) {
    memberIdsByDraft[canonical].push(...memberIdsByDraft[absorbed]);
  }

  const out: ThemeDraft[] = [];
  drafts.forEach((draft, index) => {
    if (absorbedInto.has(index)) return;
    if (!memberIdsByDraft[index].length) return;
    const members = memberIdsByDraft[index]
      .map((id) => phraseById.get(id))
      .filter((phrase): phrase is PhraseForClustering => phrase !== undefined);
    if (members.length !== memberIdsByDraft[index].length || !members.length) {
      // Unknown phrase ids — keep the original draft untouched.
      out.push(draft);
      return;
    }
    const merged = draftFrom(members, config, draft.isCatchall);
    merged.label = draft.label;
    merged.summary = draft.summary;
    out.push(merged);
  });
  return out;
}

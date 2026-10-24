/**
 * Brand → industry classifier. Maps a tracked competitor onto one of the 16
 * Industry Explorer verticals (`lib/brand-identity/industries.ts`) from its page
 * name + ad-copy corpus, so the labelling pipeline can pick that industry's angle
 * vocabulary (`industry-taxonomy.ts`).
 *
 * Unlike the heuristic `brand-type-classifier.ts`, industry is hard to derive
 * from numeric corpus signals, so this makes one cheap `gpt-4o-mini` call with a
 * strict enum. It is confidence-gated: weak/ambiguous signal returns `null`, and
 * the sync wiring then leaves `industry` unset (the brand stays on the universal
 * angle list — zero regression). The caller decides whether to auto-apply.
 */

import { openAIChatCompletion } from '@/lib/llm/clients';
import { z } from 'zod';
import { INDUSTRY_KEYS, type IndustryKey } from './industries';
import { modelForRole } from '@/lib/llm/model-roles';

/** Below this confidence we keep `industry` unset (universal angles). */
export const MIN_INDUSTRY_CONFIDENCE = 0.6;
/** Max ad bodies fed to the model — enough signal without a huge prompt. */
const MAX_CORPUS_ADS = 25;
const MAX_BODY_CHARS = 400;

export interface IndustryClassificationInput {
  pageName: string | null;
  /** Primary creative bodies from the scraped corpus (raw, may be empty). */
  adCopyCorpus: string[];
}

export interface IndustrySuggestion {
  /** A known industry key, or null when signal is weak/ambiguous. */
  industry: IndustryKey | null;
  /** 0..1 — only suggestions at/above MIN_INDUSTRY_CONFIDENCE escape null. */
  confidence: number;
  rationale: string;
}

const responseItemSchema = z.object({
  industry: z.string(),
  confidence: z.number(),
  rationale: z.string().optional(),
});

function buildResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'brand_industry',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['industry', 'confidence', 'rationale'],
        properties: {
          industry: {
            type: 'string',
            // 'none' is the explicit "does not fit / not enough signal" escape.
            enum: [...INDUSTRY_KEYS, 'none'],
          },
          confidence: {
            type: 'number',
            description: 'Confidence from 0 to 1 that the brand is in this industry',
          },
          rationale: {
            type: 'string',
            description: 'One short sentence justifying the classification',
          },
        },
      },
    },
  };
}

const SYSTEM_PROMPT = `You classify advertising brands into a fixed list of retail/e-commerce industries for a creative-intelligence tool. Given a brand's page name and a sample of its ad copy, pick the single best-fitting industry key from the allowed list. If the brand clearly does not fit any industry, or there is not enough signal to tell, return "none". Set confidence to reflect how certain you are.`;

function buildCorpusText(input: IndustryClassificationInput): string {
  const bodies = input.adCopyCorpus
    .filter((b) => typeof b === 'string' && b.trim().length > 0)
    .slice(0, MAX_CORPUS_ADS)
    .map((b) => b.slice(0, MAX_BODY_CHARS));
  return [
    `Brand page name: ${input.pageName ?? '(unknown)'}`,
    '',
    'Sample ad copy:',
    ...bodies.map((b, i) => `${i + 1}. ${b}`),
  ].join('\n');
}

/**
 * Classifies a brand into one of the 16 industries. Returns `industry: null`
 * when the model answers "none", confidence is below the gate, or the corpus is
 * too thin to ask. Never throws on a missing corpus; provider errors propagate
 * so the caller (a best-effort sync step) can swallow them.
 */
export async function suggestIndustry(
  input: IndustryClassificationInput,
  opts: { model?: string; signal?: AbortSignal } = {}
): Promise<IndustrySuggestion> {
  const hasCorpus = input.adCopyCorpus.some(
    (b) => typeof b === 'string' && b.trim().length > 0
  );
  if (!input.pageName && !hasCorpus) {
    return { industry: null, confidence: 0, rationale: 'No page name or ad copy to classify.' };
  }

  const model = opts.model ?? modelForRole('industry_classifier');
  const completion = await openAIChatCompletion({
    body: {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildCorpusText(input) },
      ],
      response_format: buildResponseFormat(),
      temperature: 0,
    },
    signal: opts.signal,
    retryProfile: 'background',
  });

  const content = (
    completion as { choices?: Array<{ message?: { content?: string } }> }
  ).choices?.[0]?.message?.content;
  if (!content) {
    return { industry: null, confidence: 0, rationale: 'No classification returned.' };
  }

  // A truncated/non-JSON LLM response must degrade to the same graceful
  // null-classification as a schema mismatch — never a thrown SyntaxError.
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { industry: null, confidence: 0, rationale: 'Malformed classification.' };
  }
  const parsed = responseItemSchema.safeParse(json);
  if (!parsed.success) {
    return { industry: null, confidence: 0, rationale: 'Malformed classification.' };
  }

  const { industry, confidence, rationale } = parsed.data;
  const clamped = Math.min(1, Math.max(0, confidence));
  const isKnown = (INDUSTRY_KEYS as readonly string[]).includes(industry);
  if (!isKnown || clamped < MIN_INDUSTRY_CONFIDENCE) {
    return {
      industry: null,
      confidence: clamped,
      rationale: rationale ?? 'Below confidence threshold or no clear fit.',
    };
  }
  return { industry: industry as IndustryKey, confidence: clamped, rationale: rationale ?? '' };
}

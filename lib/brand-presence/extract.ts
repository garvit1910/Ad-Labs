/**
 * The merged extraction LLM step (pure — no DB), REPLACING the old
 * insights.ts pass: one cheap-model call per batch annotates each kept
 * mention with (a) the exact legacy tags.insight fields (competitors, angle,
 * sentiment enum, gist, usable — the Competitors/Category sections and the
 * mentions/list competitor filter depend on that shape) and (b) the new
 * phrase decomposition powering themes: atomic pains/desires/objections/
 * praise phrases with normalized paraphrases, a numeric sentiment score, and
 * verbatim hook-worthy quotes. Quotes are validated programmatically as
 * exact substrings of the mention text — LLMs paraphrase when not policed.
 * Mirrors relevance.ts: strict json_schema, malformed/unknown items dropped
 * (they stay eligible for the next pass).
 */
import { z } from 'zod';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import { BRAND_PRESENCE_CONFIG } from './config';
import {
  MENTION_ANGLES,
  MENTION_SENTIMENTS,
  type MentionAngle,
  type MentionScope,
  type MentionSentiment,
} from './types';
import { decodeChatJson, strictResponseFormat } from './llm';
import { modelForRole } from '@/lib/llm/model-roles';

/**
 * Extraction defaults to the cheap model (it runs on every kept mention);
 * BRAND_PRESENCE_EXTRACT_MODEL restores the full model if quality demands.
 */
export function getExtractModel(): string {
  return modelForRole('brand_presence_extract');
}

export interface ExtractBrandCard {
  brand_name: string;
  category: string | null;
  competitors: string[];
}

export interface MentionToExtract {
  mention_id: string;
  platform: string;
  scope: MentionScope;
  subreddit: string | null;
  title: string | null;
  body: string | null;
  /** Star rating for review platforms — a strong sentiment prior. */
  rating: number | null;
  /** Optional platform-specific surrounding context (e.g. the TikTok video
   * caption a comment was posted under — "does it work on the second one?"
   * is meaningless without it). Interpretation aid ONLY: never a phrase or
   * quote source (quotes validate against title+body). Composed per-platform
   * by the extract processor; null everywhere it doesn't apply. */
  context: string | null;
}

export interface ExtractedPhrase {
  /** Near-verbatim atomic signal (one idea only). */
  phrase: string;
  /** Short neutral restatement — what gets embedded and clustered. */
  paraphrase: string;
}

export interface MentionExtractVerdict {
  mention_id: string;
  // Legacy tags.insight fields (exact shape preserved):
  competitors: string[];
  angle: MentionAngle;
  sentiment: MentionSentiment;
  gist: string;
  usable: boolean;
  // New extraction fields:
  /** -1..1 numeric sentiment (drives phrase/theme sentiment math). */
  sentimentScore: number;
  pains: ExtractedPhrase[];
  desires: ExtractedPhrase[];
  objections: ExtractedPhrase[];
  praise: ExtractedPhrase[];
  /** Verbatim candidates — callers MUST run validateVerbatimQuotes. */
  quotes: string[];
}

const phraseSchema = z.object({
  phrase: z.string().min(1),
  paraphrase: z.string().min(1),
});

const extractItemSchema = z.object({
  mention_id: z.string().min(1),
  competitors: z.array(z.string()),
  angle: z.enum(MENTION_ANGLES),
  sentiment: z.enum(MENTION_SENTIMENTS),
  gist: z.string(),
  usable: z.boolean(),
  sentiment_score: z.number(),
  pains: z.array(phraseSchema),
  desires: z.array(phraseSchema),
  objections: z.array(phraseSchema),
  praise: z.array(phraseSchema),
  quotes: z.array(z.string()),
});

const extractResponseSchema = z.object({
  extractions: z.array(z.unknown()),
});

const PHRASE_ARRAY_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['phrase', 'paraphrase'],
    properties: {
      phrase: {
        type: 'string',
        description: 'Near-verbatim atomic signal from the text (ONE idea)',
      },
      paraphrase: {
        type: 'string',
        description:
          'Short neutral restatement of the same signal (<=90 chars)',
      },
    },
  },
} as const;

const RESPONSE_FORMAT = strictResponseFormat('mention_extractions', {
  type: 'object',
  additionalProperties: false,
  required: ['extractions'],
  properties: {
    extractions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'mention_id',
          'competitors',
          'angle',
          'sentiment',
          'gist',
          'usable',
          'sentiment_score',
          'pains',
          'desires',
          'objections',
          'praise',
          'quotes',
        ],
        properties: {
          mention_id: { type: 'string' },
          competitors: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Competitor/other brand names named in this item (never the analyzed brand itself)',
          },
          angle: { type: 'string', enum: [...MENTION_ANGLES] },
          sentiment: { type: 'string', enum: [...MENTION_SENTIMENTS] },
          gist: {
            type: 'string',
            description: 'One quote-worthy sentence (<=120 chars)',
          },
          usable: {
            type: 'boolean',
            description:
              'false when this item has no standalone voice-of-customer value: deleted/removed, a bare reaction ("nice", "those are the good ones"), or meaningless without external context',
          },
          sentiment_score: {
            type: 'number',
            description:
              'Overall sentiment toward the product/brand, -1 (hostile) .. 0 (neutral) .. 1 (delighted)',
          },
          pains: PHRASE_ARRAY_SCHEMA,
          desires: PHRASE_ARRAY_SCHEMA,
          objections: PHRASE_ARRAY_SCHEMA,
          praise: PHRASE_ARRAY_SCHEMA,
          quotes: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Genuinely hook-worthy CUSTOMER sentences copied EXACTLY word-for-word — a vivid, specific, emotional reaction/claim a marketer could put on an ad. NOT brand captions, engagement-bait questions, friend tags, bare emoji/one-word reactions, or jokes. Zero rewording, zero fixes. Empty (the common case) when nothing is quotable.',
          },
        },
      },
    },
  },
});

function buildSystemPrompt(card: ExtractBrandCard): string {
  return `You extract voice-of-customer signal from posts, comments, and product reviews in the "${card.category ?? 'product'}" category for the brand ${card.brand_name}. For each item return:
- competitors: the other/competitor brand names the text actually names. Match against the known competitor list where possible (use the list's spelling); add any other clearly-named brand verbatim. NEVER include "${card.brand_name}" itself. Empty array if no brand is named.
- angle: the dominant angle — "pain_point" (a frustration/problem), "praise" (what they like), "wish" (a desire or feature they want), "question" (asking for help/recommendations), "comparison" (weighing options/brands), or "other".
- sentiment: "positive", "negative", "neutral", or "mixed".
- gist: ONE short quote-worthy sentence (<=120 chars) capturing the takeaway.
- usable: true if this item carries real voice-of-customer signal a marketer could act on; false if it is deleted/removed, a bare reaction or one-liner with no substance ("nice", "those are the good ones", "true OG"), or meaningless without context you don't have.
- sentiment_score: a number from -1 to 1 for the overall sentiment (star ratings are a strong prior: 1-2 stars lean negative, 5 stars lean positive — but the TEXT decides).
- pains / desires / objections / praise: ATOMIC signals decomposed from the text. One signal per entry — split compound complaints ("arrived crushed and tastes stale" = two pains). phrase stays close to the author's wording; paraphrase is a short neutral restatement (<=90 chars) suitable for grouping similar signals across authors. Empty arrays are correct when the text carries no such signal.
- quotes: 0-3 genuinely hook-worthy sentences copied EXACTLY, word-for-word, from the item's text. A hook-worthy quote is a CUSTOMER saying something a marketer could put on an ad: a vivid, specific, emotionally-charged reaction or claim ("I've tried every protein cereal and this is the only one that doesn't taste like cardboard"). It is NOT the brand's own caption or engagement-bait question ("Which flavor would you pick up?"), a tag to a friend ("@dana you have to try these"), a bare one-word or emoji reaction ("Delicious 🤤", "😍🔥"), or an off-topic joke. Most items have ZERO quotable lines — return an empty array rather than settling for filler. Do not fix typos, do not trim words mid-sentence, do not paraphrase — an inexact quote is worthless and will be discarded.

Items marked scope "competitor" are about competitor brands: return their competitors/angle/sentiment/gist/usable as usual but EMPTY pains/desires/objections/praise/quotes arrays (their phrases are not collected).

Some items carry a "context" field describing where the text appeared (for example the video caption a comment was left under). Use it ONLY to interpret the item — questions in comments are often objections in disguise ("does this ship to X?" = a shipping objection). NEVER extract phrases or quotes from the context text itself; phrases and quotes come from the item's own title/body only.

Known competitors: ${card.competitors.join(', ') || 'none provided'}.
Judge every item and return its exact mention_id. Return STRICT JSON.`;
}

/**
 * One structured LLM call over a batch. Malformed / unknown-id items are
 * dropped (they stay eligible for the next pass). The analyzed brand is
 * defensively stripped from competitors in case the model ignores the rule;
 * competitor-scope items have their phrase arrays force-emptied.
 */
export async function extractMentionSignals(
  card: ExtractBrandCard,
  mentions: MentionToExtract[],
  opts: { signal?: AbortSignal; maxBodyChars?: number } = {},
): Promise<MentionExtractVerdict[]> {
  const maxBodyChars = opts.maxBodyChars ?? 1500;
  const forPrompt = mentions.map((mention) => ({
    mention_id: mention.mention_id,
    platform: mention.platform,
    scope: mention.scope,
    subreddit: mention.subreddit,
    rating: mention.rating,
    context: mention.context,
    title: mention.title,
    body: mention.body ? mention.body.slice(0, maxBodyChars) : null,
  }));

  const completion = await openAIChatCompletion({
    body: {
      model: getExtractModel(),
      messages: [
        { role: 'system', content: buildSystemPrompt(card) },
        {
          role: 'user',
          content: `Analyze these ${mentions.length} items:\n${JSON.stringify(forPrompt, null, 2)}`,
        },
      ],
      response_format: RESPONSE_FORMAT,
      temperature: 0.2,
      max_completion_tokens: BRAND_PRESENCE_CONFIG.extract.maxOutputTokens,
      // Queue job, no human waiting → Flex tier (50% off).
      ...flexServiceTier(),
    },
    signal: opts.signal,
    retryProfile: 'background',
  });

  const parsed = extractResponseSchema.parse(decodeChatJson(completion));
  const byId = new Map(
    mentions.map((mention) => [mention.mention_id, mention]),
  );
  const brandKey = card.brand_name.trim().toLowerCase();
  const seen = new Set<string>();
  const verdicts: MentionExtractVerdict[] = [];
  for (const rawItem of parsed.extractions) {
    const item = extractItemSchema.safeParse(rawItem);
    if (!item.success) continue;
    const mention = byId.get(item.data.mention_id);
    if (!mention) continue;
    if (seen.has(item.data.mention_id)) continue;
    seen.add(item.data.mention_id);
    const competitors = dedupeStrings(
      item.data.competitors.filter(
        (name) => name.trim() !== '' && name.trim().toLowerCase() !== brandKey,
      ),
    );
    const isCompetitorScope = mention.scope === 'competitor';
    verdicts.push({
      mention_id: item.data.mention_id,
      competitors,
      angle: item.data.angle,
      sentiment: item.data.sentiment,
      gist: item.data.gist.slice(0, 200),
      usable: item.data.usable,
      sentimentScore: clampSigned(item.data.sentiment_score),
      pains: isCompetitorScope ? [] : normalizePhrases(item.data.pains),
      desires: isCompetitorScope ? [] : normalizePhrases(item.data.desires),
      objections: isCompetitorScope
        ? []
        : normalizePhrases(item.data.objections),
      praise: isCompetitorScope ? [] : normalizePhrases(item.data.praise),
      quotes: isCompetitorScope ? [] : item.data.quotes,
    });
  }
  return verdicts;
}

/**
 * Verbatim integrity gate: a "quote" survives only when it is an exact
 * substring of the mention text (whitespace runs normalized on both sides —
 * models legitimately collapse double spaces/newlines, everything else is
 * paraphrasing and gets dropped). Returns the surviving quotes as returned
 * by the model, deduped.
 */
export function validateVerbatimQuotes(
  quotes: string[],
  rawText: string,
): string[] {
  const haystack = normalizeWhitespace(rawText).toLowerCase();
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const quote of quotes) {
    const trimmed = quote.trim();
    if (trimmed.length < 8) continue; // too short to be a hook
    const needle = normalizeWhitespace(trimmed).toLowerCase();
    if (!haystack.includes(needle)) continue;
    const key = needle;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(trimmed);
  }
  return valid;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Clamp to [-1, 1] (clamp01 is 0..1 — sentiment is signed). */
function clampSigned(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function normalizePhrases(phrases: ExtractedPhrase[]): ExtractedPhrase[] {
  const seen = new Set<string>();
  const result: ExtractedPhrase[] = [];
  for (const entry of phrases) {
    const phrase = entry.phrase.trim();
    const paraphrase = entry.paraphrase.trim();
    if (phrase === '' || paraphrase === '') continue;
    const key = paraphrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      phrase: phrase.slice(0, 500),
      paraphrase: paraphrase.slice(0, 200),
    });
  }
  return result;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

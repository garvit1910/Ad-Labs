/**
 * The relevance gate LLM step (pure — no DB). Batches of pending mentions are
 * judged against a compact disambiguation card. Thresholding is conservative:
 * a false-positive "relevant" pollutes the VOC corpus and produces wrong ads
 * downstream, so only confident relevant verdicts survive — everything else
 * (irrelevant verdicts and low-confidence relevant ones) becomes irrelevant.
 */

import { z } from 'zod';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import { BRAND_PRESENCE_CONFIG } from './config';
import type { MentionRelevance } from './types';
import {
  clamp01,
  decodeChatJson,
  getBrandPresenceModel,
  strictResponseFormat,
} from './llm';
import { modelForRole } from '@/lib/llm/model-roles';

/**
 * The relevance gate is the one call where judgment quality directly decides
 * what pollutes the VOC corpus, so it runs on the full gpt-5.4 (not mini —
 * the discovery/subreddit calls keep the cheap model). Override with
 * BRAND_PRESENCE_RELEVANCE_MODEL.
 */
function getRelevanceModel(): string {
  return modelForRole('brand_presence_relevance');
}

export interface BrandDisambiguationCard {
  brand_name: string;
  name_variants: string[];
  domain: string;
  category: string | null;
  product_description: string | null;
  /** Competitor brand names — category-scope items are judged against these. */
  competitors: string[];
}

export interface MentionToJudge {
  mention_id: string;
  /** brand items are judged for brand-aboutness; competitor items for genuine
   * competitor-brand discussion; category items for genuine category
   * discussion — all vs homonyms & other languages. */
  scope: 'brand' | 'competitor' | 'category';
  /** Source platform ('reddit' | 'amazon' | 'google_maps' | 'x') — medium
   * context for the judge (X keyword search is dense with marketing spam). */
  platform: string;
  subreddit: string | null;
  title: string | null;
  body: string | null;
}

export interface RelevanceVerdict {
  mention_id: string;
  relevant: boolean;
  confidence: number;
}

const verdictItemSchema = z.object({
  mention_id: z.string().min(1),
  relevant: z.boolean(),
  confidence: z.number(),
});

const verdictResponseSchema = z.object({
  verdicts: z.array(z.unknown()),
});

const RESPONSE_FORMAT = strictResponseFormat('mention_relevance', {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['mention_id', 'relevant', 'confidence'],
        properties: {
          mention_id: { type: 'string' },
          relevant: {
            type: 'boolean',
            description:
              'true only when the text is genuinely about THIS brand',
          },
          confidence: { type: 'number', description: '0 to 1' },
        },
      },
    },
  },
});

function buildSystemPrompt(card: BrandDisambiguationCard): string {
  return `You decide whether social posts, comments, and reviews (each item carries its platform) are genuine voice-of-customer signal for a brand. The brand:
- Name: ${card.brand_name}
- Also written as: ${card.name_variants.join(', ')}
- Website: ${card.domain}
- Category: ${card.category ?? 'unknown'}
- What it sells: ${card.product_description ?? 'unknown'}
- Competitors: ${card.competitors.join(', ') || 'unknown'}

Each item carries a scope:
- scope "brand": relevant ONLY if the text refers to this specific brand or its products — not a dictionary word, a different company with a similar name, a person, a place, or an unrelated acronym.
- scope "competitor": relevant ONLY if the text is genuinely about one of the listed competitor BRANDS as a company/product — not a homonym, a word in another language (e.g. French "ethique" is NOT the brand Ethique), a person, a place, or an unrelated topic that merely contains a matching word.
- scope "category": relevant ONLY if the text is genuinely about the SPECIFIC "${card.category ?? 'product'}" product/service — someone buying, using, comparing, recommending, or describing a real pain point/experience with it. It is NOT relevant if it is merely tangential hobby/enthusiast chatter in the same broad domain: e.g. for "auto repair financing" a car-enthusiast post about Ferrari gearboxes or dashboard touchscreens is NOT about auto repair financing; for "solid skincare" a general zero-waste rant that never touches the product is NOT relevant. Same broad industry is not enough — it must be about THIS product/service.

Regardless of scope, voice-of-customer means a real customer or prospect speaking: experiences, complaints, praise, questions, comparisons, recommendations. Marketing, promotional, affiliate/deal, giveaway, or self-promotional content is NOT voice-of-customer even when it genuinely names or discusses the brand — mark relevant=false for: a marketer/agency case study or client name-drop, discount/coupon/deal posts, giveaway or contest entries, influencer ad copy, and the brand's own promotional copy reposted by others. This matters most for platform "x", where keyword search is dense with such spam.

When you cannot tell, mark relevant=false. Judge every item and return its exact mention_id. Return STRICT JSON.`;
}

/**
 * One structured LLM call over a batch (~relevanceBatchSize items).
 * Malformed / unknown-id verdicts are dropped, not fatal — the mentions they
 * covered simply stay pending for the next pass.
 */
export async function classifyMentionRelevance(
  card: BrandDisambiguationCard,
  mentions: MentionToJudge[],
  opts: { signal?: AbortSignal; model?: string } = {},
): Promise<RelevanceVerdict[]> {
  const forPrompt = mentions.map((mention) => ({
    mention_id: mention.mention_id,
    scope: mention.scope,
    platform: mention.platform,
    subreddit: mention.subreddit,
    title: mention.title,
    // Enough text to disambiguate without blowing the prompt budget.
    body: mention.body ? mention.body.slice(0, 1200) : null,
  }));

  const completion = await openAIChatCompletion({
    body: {
      model: opts.model ?? getRelevanceModel(),
      messages: [
        { role: 'system', content: buildSystemPrompt(card) },
        {
          role: 'user',
          content: `Judge these ${mentions.length} items:\n${JSON.stringify(forPrompt, null, 2)}`,
        },
      ],
      response_format: RESPONSE_FORMAT,
      temperature: 0.1,
      max_completion_tokens: BRAND_PRESENCE_CONFIG.relevanceMaxOutputTokens,
      // Queue job, no human waiting → Flex tier (50% off). Both cascade stages
      // route through here, so cheap + escalated legs are both discounted.
      ...flexServiceTier(),
    },
    signal: opts.signal,
    retryProfile: 'background',
  });

  const parsed = verdictResponseSchema.parse(decodeChatJson(completion));
  const knownIds = new Set(mentions.map((mention) => mention.mention_id));
  const seen = new Set<string>();
  const verdicts: RelevanceVerdict[] = [];
  for (const rawItem of parsed.verdicts) {
    const item = verdictItemSchema.safeParse(rawItem);
    if (!item.success) continue;
    if (!knownIds.has(item.data.mention_id)) continue;
    if (seen.has(item.data.mention_id)) continue;
    seen.add(item.data.mention_id);
    verdicts.push({ ...item.data, confidence: clamp01(item.data.confidence) });
  }
  return verdicts;
}

export interface CascadeResult {
  verdicts: RelevanceVerdict[];
  /** Mentions judged by the cheap model. */
  cheapJudged: number;
  /** Mentions re-judged by the full model (ambiguous band + cheap misses). */
  escalated: number;
}

/**
 * Relevance with a two-stage model cascade.
 *
 * Stage 1 judges the whole batch on the cheap model. Stage 2 re-judges ONLY
 * the mentions where the cheap verdict could plausibly differ from the full
 * model's, and the full model's verdict wins. Two classes escalate:
 *
 *  - **Ambiguous band** — confidence within `[escalateFrom, escalateTo]`,
 *    bracketing the `irrelevantConfidenceFloor` where a verdict actually
 *    changes the stored outcome.
 *  - **Cheap misses** — mentions the cheap model dropped or returned malformed
 *    verdicts for. Without this they would stay `pending` and silently shrink
 *    corpus coverage, converting a model-quality regression into invisible
 *    data loss rather than a cost saving.
 *
 * Escalated mentions therefore receive TWO independent judgments; the gate is
 * strictly more conservative there, not less. With `enabled: false` this is
 * one full-model call — the exact pre-cascade behavior.
 */
export async function classifyMentionRelevanceCascaded(
  card: BrandDisambiguationCard,
  mentions: MentionToJudge[],
  opts: { signal?: AbortSignal } = {},
): Promise<CascadeResult> {
  const cascade = BRAND_PRESENCE_CONFIG.relevanceCascade;
  // An empty batch must never reach the wire — judging nothing still bills a
  // full prompt (the disambiguation card is in the system message).
  if (mentions.length === 0) {
    return { verdicts: [], cheapJudged: 0, escalated: 0 };
  }
  if (!cascade.enabled) {
    const verdicts = await classifyMentionRelevance(card, mentions, opts);
    return { verdicts, cheapJudged: 0, escalated: verdicts.length };
  }

  const cheapVerdicts = await classifyMentionRelevance(card, mentions, {
    ...opts,
    model: getBrandPresenceModel(),
  });
  const byId = new Map(cheapVerdicts.map((v) => [v.mention_id, v]));

  const needsEscalation = mentions.filter((mention) => {
    const verdict = byId.get(mention.mention_id);
    if (!verdict) return true; // cheap miss — never silently drop coverage
    return (
      verdict.confidence >= cascade.escalateFrom &&
      verdict.confidence <= cascade.escalateTo
    );
  });

  if (needsEscalation.length === 0) {
    return {
      verdicts: cheapVerdicts,
      cheapJudged: cheapVerdicts.length,
      escalated: 0,
    };
  }

  const fullVerdicts = await classifyMentionRelevance(
    card,
    needsEscalation,
    opts,
  );
  for (const verdict of fullVerdicts) {
    byId.set(verdict.mention_id, verdict);
  }

  return {
    verdicts: [...byId.values()],
    cheapJudged: cheapVerdicts.length,
    escalated: fullVerdicts.length,
  };
}

/**
 * Conservative verdict -> stored relevance mapping: relevant only when the
 * model is confident it IS about the brand; anything uncertain is irrelevant
 * (see BRAND_PRESENCE_CONFIG.irrelevantConfidenceFloor rationale).
 */
export function verdictToRelevance(
  verdict: RelevanceVerdict,
): MentionRelevance {
  return verdict.relevant &&
    verdict.confidence >= BRAND_PRESENCE_CONFIG.irrelevantConfidenceFloor
    ? 'relevant'
    : 'irrelevant';
}

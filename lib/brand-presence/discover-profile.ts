/**
 * Brand Presence discovery LLM step: homepage text -> the draft brand
 * profile the founder confirms before scraping. Pure LLM boundary (no DB) so
 * it stays unit-testable with a mocked openAIChatCompletion — mirrors
 * lib/brand-identity/suggest-competitors.ts.
 */

import { z } from 'zod';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import {
  decodeChatJson,
  getBrandPresenceModel,
  strictResponseFormat,
} from './llm';

export interface ExtractedBrandProfile {
  brand_name: string;
  name_variants: string[];
  product_description: string;
  category: string;
  competitor_candidates: string[];
}

const extractedProfileSchema = z.object({
  brand_name: z.string().min(1),
  name_variants: z.array(z.string()),
  product_description: z.string(),
  category: z.string(),
  competitor_candidates: z.array(z.string()),
});

const RESPONSE_FORMAT = strictResponseFormat('brand_profile', {
  type: 'object',
  additionalProperties: false,
  required: [
    'brand_name',
    'name_variants',
    'product_description',
    'category',
    'competitor_candidates',
  ],
  properties: {
    brand_name: { type: 'string' },
    name_variants: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Every string people use for this brand in casual online writing',
    },
    product_description: {
      type: 'string',
      description: 'Two to three sentences on what the brand sells and to whom',
    },
    category: {
      type: 'string',
      description: 'Short product-category label, e.g. "greens powder"',
    },
    competitor_candidates: {
      type: 'array',
      items: { type: 'string' },
      description: 'Real competitor brand names in the same category',
    },
  },
});

const SYSTEM_PROMPT = `You are a brand-research analyst for a social-listening product. Given the text of a brand's own homepage, extract the identity we need to find every online mention of it:
- brand_name: the canonical brand name.
- name_variants: the exact strings people type when mentioning the brand online — include the brand name, a spaced variant if the name concatenates words (e.g. "GutRelief" -> "Gut Relief"), the website domain without its TLD, and the brand's @handle if the page shows one. Only include variants specific enough to search for; never generic dictionary words on their own.
- product_description: 2-3 sentences on what the brand sells, its form factor, and the customer it targets.
- category: a short category label a shopper would use (e.g. "greens powder", "linen bedding").
- competitor_candidates: real, currently-operating competitor brands in the same category. Do not invent brands. Do not include the brand itself.
Return STRICT JSON matching the schema.`;

function buildUserPrompt(homepageText: string, websiteUrl: string): string {
  // The fetch helper caps at ~15k chars; this is a defensive second bound.
  const excerpt = homepageText.slice(0, 12000);
  return `Brand homepage URL: ${websiteUrl}

Homepage text:
"""
${excerpt}
"""`;
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

/** Derives the domain-without-TLD variant so it is present even when the
 * model forgets it (it is the highest-recall Reddit search term). Exported so
 * the discover job can seed a degraded draft's name when a homepage is
 * unreadable (bot-blocked). */
export function domainVariant(websiteUrl: string): string | null {
  try {
    const host = new URL(
      /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`,
    ).hostname.replace(/^www\./, '');
    const stem = host.split('.')[0]?.trim();
    return stem && stem.length >= 3 ? stem : null;
  } catch {
    return null;
  }
}

export async function extractBrandProfile(
  homepageText: string,
  websiteUrl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExtractedBrandProfile> {
  const completion = await openAIChatCompletion({
    body: {
      model: getBrandPresenceModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(homepageText, websiteUrl) },
      ],
      response_format: RESPONSE_FORMAT,
      temperature: 0.2,
      // Queue job (brand-presence onboarding), no human waiting → Flex tier.
      ...flexServiceTier(),
    },
    signal: opts.signal,
    retryProfile: 'background',
  });

  const parsed = extractedProfileSchema.parse(decodeChatJson(completion));
  const stem = domainVariant(websiteUrl);
  return {
    ...parsed,
    brand_name: parsed.brand_name.trim(),
    name_variants: dedupeStrings([
      parsed.brand_name,
      ...parsed.name_variants,
      ...(stem ? [stem] : []),
    ]),
    competitor_candidates: dedupeStrings(parsed.competitor_candidates),
  };
}

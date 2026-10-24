/**
 * Subreddit-discovery LLM steps (pure — no DB, no Apify):
 *  #1 proposeSubreddits: product description -> candidate subreddits +
 *     category search keywords. Candidates only — LLMs hallucinate subreddit
 *     names, so the processor verifies them against real communities via a
 *     searchCommunities actor run before anything is scraped.
 *  #2 selectSubreddits: verified communities + candidates -> the 4-6 to
 *     track, each classified core (brand's product category) or adjacent
 *     (audience hangs out there, category comes up).
 */

import { z } from 'zod';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import { BRAND_PRESENCE_CONFIG } from './config';
import {
  SUBREDDIT_CLASSIFICATIONS,
  type SubredditClassification,
  type VerifiedCommunity,
} from './types';
import {
  clamp01,
  decodeChatJson,
  getBrandPresenceModel,
  strictResponseFormat,
} from './llm';

export interface SubredditProposal {
  candidates: string[];
  keywords: string[];
}

export interface SelectedSubreddit {
  name: string;
  classification: SubredditClassification;
  confidence: number;
}

const proposalSchema = z.object({
  subreddits: z.array(z.string()),
  keywords: z.array(z.string()),
});

const PROPOSAL_FORMAT = strictResponseFormat('subreddit_proposal', {
  type: 'object',
  additionalProperties: false,
  required: ['subreddits', 'keywords'],
  properties: {
    subreddits: {
      type: 'array',
      items: { type: 'string' },
      description: 'Candidate subreddit names without the r/ prefix',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'Category search keywords for verifying real communities',
    },
  },
});

const selectionItemSchema = z.object({
  name: z.string().min(1),
  classification: z.enum(SUBREDDIT_CLASSIFICATIONS),
  confidence: z.number(),
});

const selectionSchema = z.object({
  selected: z.array(z.unknown()),
});

const SELECTION_FORMAT = strictResponseFormat('subreddit_selection', {
  type: 'object',
  additionalProperties: false,
  required: ['selected'],
  properties: {
    selected: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'classification', 'confidence'],
        properties: {
          name: {
            type: 'string',
            description: 'Exact community name from the verified list',
          },
          classification: {
            type: 'string',
            enum: [...SUBREDDIT_CLASSIFICATIONS],
          },
          confidence: { type: 'number', description: '0 to 1' },
        },
      },
    },
  },
});

function normalizeName(raw: string): string {
  return raw.trim().replace(/^\/?r\//i, '').replace(/\/+$/, '');
}

function dedupeNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const name = normalizeName(value);
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

export async function proposeSubreddits(
  profile: {
    brand_name: string;
    product_description: string | null;
    category: string | null;
    competitors: string[];
  },
  opts: { signal?: AbortSignal } = {},
): Promise<SubredditProposal> {
  const { subredditCandidates, categoryKeywords } = BRAND_PRESENCE_CONFIG;
  const completion = await openAIChatCompletion({
    body: {
      model: getBrandPresenceModel(),
      messages: [
        {
          role: 'system',
          content: `You are a Reddit-native community researcher. Given a DTC brand's product description, propose:
- subreddits: ${subredditCandidates.min}-${subredditCandidates.max} subreddits where this brand, its product category, or its target customers are actively discussed. Names only, no r/ prefix. Prefer specific product/interest communities over giant generic ones.
- keywords: ${categoryKeywords.min}-${categoryKeywords.max} short category search terms (the words a shopper would search Reddit communities for).
These are candidates that will be verified against Reddit — still, only propose subreddits you believe actually exist. Return STRICT JSON.`,
        },
        {
          role: 'user',
          content: `Brand: ${profile.brand_name}
Category: ${profile.category ?? 'unknown'}
Competitors: ${profile.competitors.join(', ') || 'unknown'}
Product description:
"""
${profile.product_description ?? ''}
"""`,
        },
      ],
      response_format: PROPOSAL_FORMAT,
      temperature: 0.4,
      // Queue job, no human waiting → Flex tier (50% off).
      ...flexServiceTier(),
    },
    signal: opts.signal,
    retryProfile: 'background',
  });

  const parsed = proposalSchema.parse(decodeChatJson(completion));
  return {
    candidates: dedupeNames(parsed.subreddits).slice(
      0,
      subredditCandidates.max,
    ),
    keywords: parsed.keywords
      .map((keyword) => keyword.trim())
      .filter((keyword, i, all) => keyword !== '' && all.indexOf(keyword) === i)
      .slice(0, categoryKeywords.max),
  };
}

/**
 * Selection is constrained to VERIFIED communities: an item whose name is not
 * in the verified list is dropped (never scraped), so a hallucinated
 * candidate can survive LLM #1 but not this gate.
 */
export async function selectSubreddits(
  profile: {
    brand_name: string;
    product_description: string | null;
    category: string | null;
  },
  candidates: string[],
  verified: VerifiedCommunity[],
  opts: { signal?: AbortSignal } = {},
): Promise<SelectedSubreddit[]> {
  const { selectedSubreddits } = BRAND_PRESENCE_CONFIG;
  const verifiedByKey = new Map(
    verified.map((community) => [community.name.toLowerCase(), community]),
  );

  const completion = await openAIChatCompletion({
    body: {
      model: getBrandPresenceModel(),
      messages: [
        {
          role: 'system',
          content: `You select which Reddit communities a brand should listen to for voice-of-customer signal about the "${profile.category ?? 'product'}" category. Pick the ${selectedSubreddits.min}-${selectedSubreddits.max} best communities FROM THE VERIFIED LIST ONLY (exact names).

TOPICALITY IS THE HARD RULE. Select ONLY communities where members actually discuss buying, using, comparing, or getting help with the SPECIFIC product/service of "${profile.category ?? 'unknown'}" — not merely the broad domain around it. Same broad industry is NOT enough.

EXCLUDE, no matter how many members they have:
- country / city / region / language subreddits (e.g. r/asksg, r/singapore, r/france)
- general question / advice / chat subreddits (e.g. r/AskReddit, r/NoStupidQuestions)
- software, tool, tech-support, piracy, or gaming subreddits unrelated to the category (e.g. r/qbittorrent)
- meme / humor / news subreddits
- broad HOBBY / ENTHUSIAST communities that only share the industry, not the actual product/service. Example: for "auto repair financing and maintenance" do NOT select r/cars (car-enthusiast culture — Ferraris, mods, dream builds), because they discuss cars as a passion, not paying for auto repair/maintenance. Prefer r/MechanicAdvice or r/AskMechanics where people actually discuss repairs and their costs.
- anything you cannot tie to the SPECIFIC "${profile.category ?? 'the category'}" service/product from its name or description

Classification: "core" = the community's actual topic IS this product/service; "adjacent" = the target customer hangs out there AND this specific product/service genuinely comes up (not just the broad hobby). Selecting FEWER than ${selectedSubreddits.min} communities — even ZERO — is BETTER than selecting one broad/off-topic community. Return STRICT JSON.`,
        },
        {
          role: 'user',
          content: `Brand: ${profile.brand_name}
Category: ${profile.category ?? 'unknown'}
Product description:
"""
${profile.product_description ?? ''}
"""

Verified communities (name, members, description). Judge each by whether its topic matches the category "${profile.category ?? 'unknown'}":
${verified
  .map(
    (community) =>
      `- ${community.name} (${community.members ?? 'unknown'} members)${community.title ? ` — ${community.title}` : ''}`,
  )
  .join('\n')}

Earlier candidate ideas (unverified, for context only): ${candidates.join(', ')}`,
        },
      ],
      response_format: SELECTION_FORMAT,
      temperature: 0.2,
      // Queue job, no human waiting → Flex tier (50% off).
      ...flexServiceTier(),
    },
    signal: opts.signal,
    retryProfile: 'background',
  });

  const parsed = selectionSchema.parse(decodeChatJson(completion));
  const seen = new Set<string>();
  const selected: SelectedSubreddit[] = [];
  for (const rawItem of parsed.selected) {
    const item = selectionItemSchema.safeParse(rawItem);
    if (!item.success) continue;
    const name = normalizeName(item.data.name);
    const key = name.toLowerCase();
    // Drop hallucinated names — only verified communities are scrapeable.
    const community = verifiedByKey.get(key);
    if (!community || seen.has(key)) continue;
    seen.add(key);
    selected.push({
      name: community.name,
      classification: item.data.classification,
      confidence: clamp01(item.data.confidence),
    });
    if (selected.length >= selectedSubreddits.max) break;
  }
  return selected;
}

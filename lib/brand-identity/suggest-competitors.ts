/**
 * "Find your competitor" LLM step.
 *
 * Given the plain-text content of a brand's own homepage, infer the industry and
 * name 5 real competitor brands that operate in the same space and are likely to
 * advertise on Meta. The caller (the `competitors/suggest` route) fetches the
 * homepage text; this module is the pure LLM boundary so it stays unit-testable
 * with a mocked `openAIChatCompletion`.
 *
 * The model only *suggests* names + websites — the caller then filters this pool
 * to the brands whose site resolves to a Facebook page (the reliable "trackable
 * on Meta" signal) before showing them.
 */

import { openAIChatCompletion } from '@/lib/llm/clients';
import { parseJsonObject, getFirstChatMessageContent } from '@/lib/llm/task-runner/json';
import { modelForRole } from '@/lib/llm/model-roles';

/**
 * Cheap, fast model for this research task (per the model registry).
 * Override with `BRAND_IDENTITY_SUGGEST_MODEL`; the default is unchanged.
 */
function getSuggestModel(): string {
  return modelForRole('suggest_competitors');
}

/**
 * Default pool size. We ask for MORE than the 5 we ultimately show because the
 * caller only surfaces brands whose website resolves to a Facebook page — many
 * candidates get filtered out, so we over-fetch to leave 5 survivors.
 */
const DEFAULT_COUNT = 12;

export interface SuggestedCompetitor {
  name: string;
  website: string;
}

export interface CompetitorSuggestions {
  industry: string;
  description: string;
  competitors: SuggestedCompetitor[];
}

export interface SuggestCompetitorsOptions {
  /** How many candidates to request. Defaults to {@link DEFAULT_COUNT}. */
  count?: number;
  /** Brand names / hostnames already shown — the model must not repeat these. */
  exclude?: string[];
}

function buildSystemPrompt(count: number): string {
  return `You are a competitive-intelligence analyst for a Meta/Facebook ads platform.
Given the text of a brand's own homepage, you identify that brand's industry and name competitor brands whose ads we can track.

These suggestions are ONLY useful if the competitor actively advertises on Meta and links its Facebook page from its website, so:
- Suggest ${count} REAL, currently-operating competitor brands in the SAME industry and market segment.
- STRONGLY prefer consumer / direct-to-consumer (DTC) brands that actively run ads on Facebook/Instagram and maintain a public Facebook page.
- AVOID B2B SaaS, software tools, agencies, marketplaces, wholesalers, and companies that do not run consumer Meta ads — even if they are direct competitors of the input brand.
- For each brand, return its primary CONSUMER storefront website (the marketing site that links its Facebook page), not a corporate/investor/app-store URL.
- Do NOT include the brand whose homepage was provided.
- Do NOT invent brands or URLs. Only include brands you are confident exist, each with its real canonical website (https://…).
- Return STRICT JSON, no prose, no markdown.`;
}

function buildUserPrompt(
  homepageText: string,
  sourceUrl: string,
  count: number,
  exclude: string[]
): string {
  // Cap the text so a huge homepage can't blow the prompt budget; the fetch
  // helper already caps at ~15k, this is a defensive second bound.
  const excerpt = homepageText.slice(0, 12000);
  const excludeLine =
    exclude.length > 0
      ? `\nDo NOT suggest any of these brands (already shown): ${exclude.join(', ')}.\n`
      : '';
  return `Brand homepage URL: ${sourceUrl}

Homepage text:
"""
${excerpt}
"""
${excludeLine}
Return a JSON object with this exact shape:
{
  "industry": "short industry / category label",
  "description": "one sentence on what this brand does",
  "competitors": [
    { "name": "Competitor Brand", "website": "https://competitor.com" }
  ]
}
The "competitors" array must contain ${count} entries.`;
}

/** Normalize a model-supplied website into a canonical https URL, or null. */
function normalizeWebsite(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Normalize a brand name / URL into a comparable hostname-ish key. */
function excludeKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.hostname.includes('.')) return url.hostname.replace(/^www\./, '');
  } catch {
    // Not a URL — fall through to treat it as a bare name.
  }
  return trimmed;
}

/** Parse + validate the model's JSON into well-formed suggestions. */
function coerceSuggestions(
  parsed: Record<string, unknown>,
  count: number,
  exclude: string[]
): CompetitorSuggestions {
  const rawList = Array.isArray(parsed.competitors) ? parsed.competitors : [];
  const competitors: SuggestedCompetitor[] = [];
  // Seed the dedupe set with excluded brands (by host AND by bare name) so a
  // "Suggest more" round can't repeat what was already shown.
  const seen = new Set<string>(exclude.map(excludeKey).filter(Boolean));

  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const website = normalizeWebsite(record.website);
    if (!name || !website) continue;

    // Dedupe by hostname and by name so the model can't return the same brand
    // twice or repeat an excluded one.
    const host = new URL(website).hostname.replace(/^www\./, '').toLowerCase();
    if (seen.has(host) || seen.has(name.toLowerCase())) continue;
    seen.add(host);
    seen.add(name.toLowerCase());

    competitors.push({ name, website });
    if (competitors.length >= count) break;
  }

  return {
    industry: typeof parsed.industry === 'string' ? parsed.industry.trim() : '',
    description:
      typeof parsed.description === 'string' ? parsed.description.trim() : '',
    competitors,
  };
}

/**
 * Ask the model for the brand's industry and a pool of competitor brands. The
 * caller filters this pool down to the ones whose website resolves to a Facebook
 * page, so we over-request ({@link DEFAULT_COUNT}) and support an `exclude` list
 * for "Suggest more" rounds. Throws the shared retryable `LlmProviderError` when
 * the model returns unparseable JSON (via {@link parseJsonObject}).
 */
export async function suggestCompetitors(
  homepageText: string,
  sourceUrl: string,
  opts: SuggestCompetitorsOptions = {}
): Promise<CompetitorSuggestions> {
  const count = opts.count ?? DEFAULT_COUNT;
  const exclude = opts.exclude ?? [];

  const response = await openAIChatCompletion({
    body: {
      model: getSuggestModel(),
      messages: [
        { role: 'system', content: buildSystemPrompt(count) },
        { role: 'user', content: buildUserPrompt(homepageText, sourceUrl, count, exclude) },
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' },
    },
    // User-facing research step: inline-retry transient provider blips quickly
    // rather than the slower background cadence, so a single hiccup doesn't
    // surface as an error to someone waiting on the modal.
    retryProfile: 'interactive',
  });

  return coerceSuggestions(
    parseJsonObject(getFirstChatMessageContent(response, '{}')),
    count,
    exclude
  );
}

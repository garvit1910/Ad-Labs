import { isQuoteInMerchantLanguage } from '@/lib/brand-object/quote-language';
import {
  rankHighlights,
  type HighlightMention,
  type ScannedMentionRow,
} from '@/lib/brand-presence/highlights';
import { rankHookQuotes } from '@/lib/brand-presence/hook-quotes';
import {
  computeSentimentMix,
  type SentimentMix,
} from '@/lib/brand-presence/pulse-metrics';
import {
  THEME_KINDS,
  type PresenceRole,
  type ThemeKind,
} from '@/lib/brand-presence/types';

/**
 * The Brand Identity report's "competitive landscape" chapter — PURE (no IO,
 * no React, no supabase). What customers say about each competitor profile
 * the org listens to, beside what they say about the report's own brand.
 *
 * ZERO LLM: every number is arithmetic over data the Brand Presence pipeline
 * already computed (kept-mention counts, clustered theme sentiment, extracted
 * mention sentiment, hook-quote phrases) and every headline is a template
 * string. Quotes are stored text rendered verbatim, ranked (never `[0]` of an
 * unranked list), and gated to the merchant's language — a foreign-language
 * mention still counts toward the totals, it is just never quoted.
 *
 * IO lives in `app/api/brand-presence/insights/competitive-landscape/loader.ts`.
 */

export const LANDSCAPE_MAX_COMPETITORS = 3;
/** Below this scored theme weight a profile's sentiment mix is null (too noisy to compare). */
export const LANDSCAPE_MIN_SAMPLE = 10;
export const LANDSCAPE_THEMES_PER_KIND = 3;
export const LANDSCAPE_HOOK_QUOTES = 3;
/** |positivePct delta| below this reads as level. */
export const LANDSCAPE_LEVEL_BAND_PCT = 5;
/**
 * The landscape ranks the newest 2,000 scored brand-scope mentions per profile
 * for its one praise + one complaint — a report page load reads up to four
 * profiles, so it scans less than the Pulse Overview highlights module, which
 * ranks the newest 5,000 (`HIGHLIGHTS_SCAN_CAP`). The two surfaces may
 * therefore pick different extremes for the same brand, by design.
 */
export const LANDSCAPE_HIGHLIGHT_SCAN_CAP = 2000;

/** How many ranked highlights per side to consider before the language gate. */
const HIGHLIGHT_CANDIDATES = 10;

export interface LandscapeTheme {
  kind: ThemeKind;
  label: string;
  summary: string | null;
  frequency: number;
  mentionCount: number;
  avgSentiment: number | null;
}

export interface LandscapeQuote {
  body: string;
  platform: string;
  url: string | null;
  rating: number | null;
  postedAt: string | null;
  sentiment: number;
}

/** Desc by kept; zero-kept platforms omitted. */
export interface LandscapePlatformCount {
  platform: string;
  kept: number;
}

export interface ProfileVoice {
  profileId: string;
  brandName: string;
  role: PresenceRole | null;
  /** Sum of `platforms[].kept`. */
  keptMentions: number;
  platforms: LandscapePlatformCount[];
  /** Null when `scoredWeight < LANDSCAPE_MIN_SAMPLE`. */
  sentiment: SentimentMix | null;
  /** Top `LANDSCAPE_THEMES_PER_KIND` per kind by frequency desc; scope='brand'
   * only; catch-all themes excluded. */
  themesByKind: Record<ThemeKind, LandscapeTheme[]>;
  /** Highest-sentiment ranked highlight that passes the merchant-language gate. */
  topPraise: LandscapeQuote | null;
  /** Lowest-sentiment ranked highlight that passes the merchant-language gate. */
  topComplaint: LandscapeQuote | null;
  /** `rankHookQuotes` top `LANDSCAPE_HOOK_QUOTES`, language-gated, verbatim. */
  hookQuotes: string[];
  /** Max `brand_presence_sources.last_synced_at` (ISO) or null. */
  lastSyncedAt: string | null;
}

export type LandscapeContrastKind = 'ahead' | 'behind' | 'level' | 'unmeasured';

export interface LandscapeContrast {
  competitorId: string;
  kind: LandscapeContrastKind;
  /** Template; names both brands; never an id. */
  headline: string;
  /** e.g. "Acme: 412 kept mentions across 3 platforms · refreshed ~2-weekly". */
  caption: string;
}

export interface CompetitiveLandscape {
  self: ProfileVoice;
  /** Kept desc, max `LANDSCAPE_MAX_COMPETITORS`, all `keptMentions > 0`. */
  competitors: ProfileVoice[];
  /** One per competitor, same order. */
  contrasts: LandscapeContrast[];
  /** ISO, injected. */
  generatedAt: string;
}

export interface ProfileVoiceInput {
  profileId: string;
  brandName: string;
  role: PresenceRole | null;
  platformCounts: LandscapePlatformCount[];
  themes: Array<{
    kind: ThemeKind;
    scope: string;
    label: string;
    summary: string | null;
    is_catchall: boolean;
    frequency: number;
    mention_count: number;
    avg_sentiment: number | null;
  }>;
  highlightRows: ScannedMentionRow[];
  quoteCandidates: Array<{ phrase: string; sentiment: number | null }>;
  lastSyncedAt: string | null;
}

function toLandscapeQuote(mention: HighlightMention): LandscapeQuote {
  return {
    body: mention.body,
    platform: mention.platform,
    url: mention.url,
    rating: mention.rating,
    postedAt: mention.postedAt,
    sentiment: mention.sentiment,
  };
}

/** First ranked mention whose body is in the merchant's language. */
function firstQuotable(ranked: HighlightMention[]): LandscapeQuote | null {
  const hit = ranked.find((mention) => isQuoteInMerchantLanguage(mention.body));
  return hit ? toLandscapeQuote(hit) : null;
}

function emptyThemesByKind(): Record<ThemeKind, LandscapeTheme[]> {
  return Object.fromEntries(THEME_KINDS.map((kind) => [kind, []])) as unknown as Record<
    ThemeKind,
    LandscapeTheme[]
  >;
}

export function buildProfileVoice(input: ProfileVoiceInput): ProfileVoice {
  const platforms = input.platformCounts
    .filter((row) => row.kept > 0)
    .map((row) => ({ platform: row.platform, kept: row.kept }))
    .sort((a, b) => b.kept - a.kept || a.platform.localeCompare(b.platform));
  const keptMentions = platforms.reduce((sum, row) => sum + row.kept, 0);

  const brandThemes = input.themes.filter((theme) => theme.scope === 'brand');
  const mix = computeSentimentMix(brandThemes);
  const sentiment = mix.scoredWeight < LANDSCAPE_MIN_SAMPLE ? null : mix;

  const themesByKind = emptyThemesByKind();
  const ranked = brandThemes
    .filter((theme) => !theme.is_catchall)
    .slice()
    .sort((a, b) => b.frequency - a.frequency);
  for (const theme of ranked) {
    const bucket = themesByKind[theme.kind];
    if (!bucket || bucket.length >= LANDSCAPE_THEMES_PER_KIND) continue;
    bucket.push({
      kind: theme.kind,
      label: theme.label,
      summary: theme.summary,
      frequency: theme.frequency,
      mentionCount: theme.mention_count,
      avgSentiment: theme.avg_sentiment,
    });
  }

  const highlights = rankHighlights(input.highlightRows, HIGHLIGHT_CANDIDATES);

  const hookQuotes = rankHookQuotes(
    input.quoteCandidates,
    LANDSCAPE_HOOK_QUOTES * 3,
  )
    .map((candidate) => candidate.phrase)
    .filter((phrase) => isQuoteInMerchantLanguage(phrase))
    .slice(0, LANDSCAPE_HOOK_QUOTES);

  return {
    profileId: input.profileId,
    brandName: input.brandName,
    role: input.role,
    keptMentions,
    platforms,
    sentiment,
    themesByKind,
    topPraise: firstQuotable(highlights.positive),
    topComplaint: firstQuotable(highlights.negative),
    hookQuotes,
    lastSyncedAt: input.lastSyncedAt,
  };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}

function contrastCaption(competitor: ProfileVoice): string {
  return (
    `${competitor.brandName}: ${plural(competitor.keptMentions, 'kept mention')} ` +
    `across ${plural(competitor.platforms.length, 'platform')} · refreshed ~2-weekly`
  );
}

export function buildLandscapeContrast(
  self: ProfileVoice,
  competitor: ProfileVoice,
): LandscapeContrast {
  const a = self.brandName;
  const b = competitor.brandName;
  const caption = contrastCaption(competitor);

  if (self.sentiment && competitor.sentiment) {
    const aPct = self.sentiment.positivePct;
    const bPct = competitor.sentiment.positivePct;
    const delta = aPct - bPct;
    if (Math.abs(delta) < LANDSCAPE_LEVEL_BAND_PCT) {
      return {
        competitorId: competitor.profileId,
        kind: 'level',
        headline: `Customers are about as positive about ${a} as about ${b} (${aPct}% vs ${bPct}% positive)`,
        caption,
      };
    }
    if (delta > 0) {
      return {
        competitorId: competitor.profileId,
        kind: 'ahead',
        headline: `Customers speak more positively about ${a} than about ${b} (${aPct}% vs ${bPct}% positive)`,
        caption,
      };
    }
    return {
      competitorId: competitor.profileId,
      kind: 'behind',
      headline: `Customers speak more positively about ${b} than about ${a} (${bPct}% vs ${aPct}% positive)`,
      caption,
    };
  }

  const underSample = [
    self.sentiment ? null : a,
    competitor.sentiment ? null : b,
  ].filter((name): name is string => name !== null);
  const sampleNote =
    underSample.length === 2
      ? `${underSample[0]} and ${underSample[1]} are still under sample`
      : `${underSample[0]} is still under sample`;
  return {
    competitorId: competitor.profileId,
    kind: 'unmeasured',
    headline: `Not enough scored customer themes yet to compare ${a} with ${b}`,
    caption: `${caption} · ${sampleNote}`,
  };
}

export function buildCompetitiveLandscape(params: {
  self: ProfileVoice;
  competitors: ProfileVoice[];
  generatedAt: string;
}): CompetitiveLandscape {
  const competitors = params.competitors
    .filter((voice) => voice.keptMentions > 0)
    .slice()
    .sort(
      (a, b) =>
        b.keptMentions - a.keptMentions || a.brandName.localeCompare(b.brandName),
    )
    .slice(0, LANDSCAPE_MAX_COMPETITORS);
  return {
    self: params.self,
    competitors,
    contrasts: competitors.map((competitor) =>
      buildLandscapeContrast(params.self, competitor),
    ),
    generatedAt: params.generatedAt,
  };
}

/**
 * Per-term Reddit kill rates and the search-term pruning they drive
 * (`BRAND_PRESENCE_CONFIG.redditTermPrune`). Pure: the relevance processor
 * loads the decided mentions and stores the snapshot on the profile; the
 * scrape processor reads it once per sync.
 *
 * Why exclusive attribution: Reddit items carry no "which query matched"
 * field, so a mention is attributed to a term only when that term is the ONLY
 * one of its list the text names. A relevant mention that also names another
 * term would still be found by that other term's search, so dropping a term
 * can only lose the relevant mentions counted in its own `relevant` — which a
 * flag allows at most (1 - flagThreshold) of.
 */
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type {
  MentionRelevance,
  ProfileMeta,
  RedditTermStat,
} from '@/lib/brand-presence/types';
import { containsNameVariant } from './reddit-normalizer';

export interface TermStatMention {
  data_type: string;
  title: string | null;
  body: string | null;
  relevance: MentionRelevance;
}

interface PruneConfig {
  flagThreshold: number;
  minSample: number;
}

/** Same text the ingest scope uses: posts title+body, comments body only. */
function mentionText(mention: TermStatMention): string {
  return mention.data_type === 'post'
    ? [mention.title, mention.body].filter(Boolean).join('\n')
    : (mention.body ?? '');
}

/**
 * Kill rate per term over the decided mentions that name it and no other term
 * of `terms`. Every term gets an entry (decided 0 when nothing attributes).
 */
export function computeTermStats(
  mentions: TermStatMention[],
  terms: string[],
  config: PruneConfig = BRAND_PRESENCE_CONFIG.redditTermPrune,
): Record<string, RedditTermStat> {
  const uniqueTerms = [...new Set(terms.filter((term) => term.trim() !== ''))];
  const tally = new Map(
    uniqueTerms.map((term) => [term, { decided: 0, relevant: 0 }]),
  );
  for (const mention of mentions) {
    if (mention.relevance !== 'relevant' && mention.relevance !== 'irrelevant') {
      continue;
    }
    const text = mentionText(mention);
    const matched = uniqueTerms.filter((term) =>
      containsNameVariant(text, [term]),
    );
    if (matched.length !== 1) continue;
    const entry = tally.get(matched[0])!;
    entry.decided += 1;
    if (mention.relevance === 'relevant') entry.relevant += 1;
  }

  const stats: Record<string, RedditTermStat> = {};
  for (const [term, { decided, relevant }] of tally) {
    const killRate = decided === 0 ? 0 : (decided - relevant) / decided;
    stats[term] = {
      decided,
      relevant,
      killRate: Number(killRate.toFixed(3)),
      flagged: decided >= config.minSample && killRate > config.flagThreshold,
    };
  }
  return stats;
}

export interface PrunedRedditTerms {
  variants: string[];
  competitors: string[];
}

/** The terms a sync drops, from the profile's stored snapshot. */
export function resolvePrunedTerms(profile: {
  name_variants: string[];
  competitors: string[];
  meta?: ProfileMeta | null;
}): PrunedRedditTerms {
  const snapshot = profile.meta?.redditTermStats;
  if (!BRAND_PRESENCE_CONFIG.redditTermPrune.enabled || !snapshot) {
    return { variants: [], competitors: [] };
  }
  return {
    variants: profile.name_variants.filter(
      (term) => snapshot.variants?.[term]?.flagged === true,
    ),
    competitors: profile.competitors.filter(
      (term) => snapshot.competitors?.[term]?.flagged === true,
    ),
  };
}

const sameTerm = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The search-side profile for one sync: pruned terms removed from the
 * variants and competitors, and the brand name nulled when it is itself a
 * pruned variant. Content scope keeps reading the FULL profile.
 */
export function applyPrunedTerms<
  P extends { brand_name: string; name_variants: string[]; competitors: string[] },
>(
  profile: P,
  pruned: PrunedRedditTerms | undefined,
): Omit<P, 'brand_name'> & { brand_name: string | null } {
  if (!pruned) return profile;
  const variants = pruned.variants ?? [];
  const competitors = pruned.competitors ?? [];
  return {
    ...profile,
    brand_name: variants.some((term) => sameTerm(term, profile.brand_name))
      ? null
      : profile.brand_name,
    name_variants: profile.name_variants.filter(
      (term) => !variants.includes(term),
    ),
    competitors: profile.competitors.filter(
      (term) => !competitors.includes(term),
    ),
  };
}

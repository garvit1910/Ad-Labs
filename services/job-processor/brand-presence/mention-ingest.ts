/**
 * Pure ingest decisions for the Reddit scrape processor — extracted so the
 * scope / containment / thread-keeping / merge state machine is unit-testable
 * without a DB or actor. The processor owns all IO; this module is a set of
 * pure functions over already-normalized items and already-loaded DB state.
 */
import type {
  MentionRelevance,
  MentionScope,
  ScrapeMode,
  SourceSyncCheckpoint,
} from '@/lib/brand-presence/types';
import { subredditSearchTerms } from '@/services/brand-presence/reddit-actor-input';
import {
  containsNameVariant,
  type NormalizedRedditMention,
} from '@/services/brand-presence/reddit-normalizer';

type ScrapePhase = SourceSyncCheckpoint['phase'];

export interface IngestProfile {
  /** Null when the brand name itself was pruned as a homonym for this sync. */
  brand_name: string | null;
  name_variants: string[];
  competitors: string[];
}

/** brand(3) > competitor(2) > category(1) — precedence when merging scope. */
export function scopeRank(scope: MentionScope): number {
  return scope === 'brand' ? 3 : scope === 'competitor' ? 2 : 1;
}

/**
 * Content-derived scope. Posts use title+body; comments use BODY ONLY — a
 * reply under a brand-titled post is NOT an exact brand mention just because
 * the post it sits under names the brand (that reply is kept as a thread child
 * instead). brand > competitor > category.
 */
export function contentScope(
  mention: Pick<NormalizedRedditMention, 'data_type' | 'title' | 'body'>,
  profile: Pick<IngestProfile, 'name_variants' | 'competitors'>,
): MentionScope {
  const text =
    mention.data_type === 'post'
      ? [mention.title, mention.body].filter(Boolean).join('\n')
      : (mention.body ?? '');
  if (containsNameVariant(text, profile.name_variants)) return 'brand';
  if (containsNameVariant(text, profile.competitors)) return 'competitor';
  return 'category';
}

/**
 * Literal terms an item's RAW text (title+body, incl. a comment's synthetic
 * "/u/X on <post title>") must contain to pass the ingest gate. Null = no gate
 * (Run A threads phase and Run B feed phase — the parent post / community is
 * already qualified, ambient replies are the point). No diacritic folding.
 */
export function requiredTermsForPhase(
  mode: ScrapeMode,
  phase: ScrapePhase,
  profile: IngestProfile,
): string[] | null {
  if (mode === 'brand_search') {
    return phase === 'threads' ? null : profile.name_variants;
  }
  if (mode === 'competitor_search') {
    // Competitor names only — the old "best {category}" keyword searches
    // dragged off-topic subreddits in as false category mentions.
    return profile.competitors;
  }
  // subreddit mode: the gate reads the same term list the search sent.
  if (phase === 'search') {
    return subredditSearchTerms(profile.brand_name, profile.competitors);
  }
  return null; // feed phase
}

export interface MentionDecision {
  keep: boolean;
  scope: MentionScope;
  relevance: MentionRelevance;
}

/**
 * Whether/how to store one normalized item, given its content scope, whether
 * it passed the containment gate, and whether it is a comment under a stored
 * brand post (thread child).
 *
 * - Gate-failing item that is NOT a thread child -> dropped.
 * - Thread child -> kept, relevance inherits the parent: irrelevant if the
 *   parent post is already decided irrelevant, else not_required (shown in the
 *   thread, never billed to the relevance LLM). Its content scope is preserved
 *   so a reply naming a competitor still feeds competitor insights.
 * - Standalone item (any scope) -> pending: brand/competitor are judged for
 *   aboutness, category for topicality (off-topic ambient community chatter is
 *   gated out instead of surfacing as noise).
 */
export function decideMention(params: {
  scope: MentionScope;
  gatePassed: boolean;
  isThreadChild: boolean;
  parentIrrelevant: boolean;
}): MentionDecision {
  const { scope, gatePassed, isThreadChild, parentIrrelevant } = params;
  if (!gatePassed && !isThreadChild) {
    return { keep: false, scope, relevance: 'not_required' };
  }
  let relevance: MentionRelevance;
  if (isThreadChild) {
    // Thread children are shown in the thread but never billed to the gate.
    relevance = parentIrrelevant ? 'irrelevant' : 'not_required';
  } else {
    // Every standalone item is gated: brand/competitor for aboutness, and
    // category for topicality (ambient community chatter that isn't genuinely
    // about the category — e.g. car-enthusiast talk under an auto-financing
    // brand — is judged irrelevant and hidden, instead of surfacing as noise).
    relevance = 'pending';
  }
  return { keep: true, scope, relevance };
}

/** Higher-rank scope wins when the same item arrives from several runs. */
export function mergeScope(
  existing: MentionScope | undefined,
  incoming: MentionScope,
): MentionScope {
  if (!existing) return incoming;
  return scopeRank(incoming) > scopeRank(existing) ? incoming : existing;
}

/**
 * Merge relevance across re-scrapes: a decided relevant|irrelevant verdict is
 * NEVER reset (protects both LLM verdicts and propagated thread verdicts); a
 * not_required item promoted to a judged scope flips to pending; otherwise the
 * existing value stands (no pending -> not_required downgrade).
 */
export function mergeRelevance(
  existing: MentionRelevance | undefined,
  incoming: MentionRelevance,
): MentionRelevance {
  if (!existing) return incoming;
  if (existing === 'relevant' || existing === 'irrelevant') return existing;
  if (existing === 'not_required' && incoming === 'pending') return 'pending';
  return existing;
}

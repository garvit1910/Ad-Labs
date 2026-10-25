/**
 * VOC fact promotion — PURE. Turns the current (unstable, rebuilt-wholesale)
 * brand_presence_themes layer + member phrases + their mentions into
 * CandidateFacts with deterministic metrics. ZERO LLM calls by design: theme
 * labels/summaries are already LLM-authored by the cluster pipeline, so this
 * stage only carries them over and computes numbers (time-decayed frequency,
 * per-platform counts, sentiment) from the mention join. Fact identity is
 * assigned by the caller via fact-key matching; this module supplies the
 * centroid (mean member vector) each candidate matches with.
 */
import { cosineSimilarity } from '@/lib/brand-identity/clustering';
import { BRAND_OBJECT_CONFIG } from './config';
import { meanVector } from './fact-key';
import { isQuoteInMerchantLanguage } from './quote-language';
import type { CandidateFact, EvidenceRef } from './types';
import { VOC_SECTION_BY_THEME_KIND } from './types';
import { compareVocRank } from './voc-rank';

export interface ThemeForPromotion {
  id: string;
  kind: string;
  scope: string;
  label: string;
  summary: string | null;
  isCatchall: boolean;
  mentionCount: number;
}

export interface PhraseForPromotion {
  id: string;
  themeId: string | null;
  mentionId: string;
  kind: string;
  phrase: string;
  vector?: number[];
}

/** Verbatim quote row (kind='quote' — substring-verified at extraction). */
export interface QuoteForPromotion {
  id: string;
  mentionId: string;
  phrase: string;
}

export interface MentionForPromotion {
  id: string;
  platform: string;
  url: string | null;
  postedAt: string | null;
}

export interface PromotionInput {
  themes: ThemeForPromotion[];
  phrases: PhraseForPromotion[];
  quotes: QuoteForPromotion[];
  mentionById: Map<string, MentionForPromotion>;
  now: Date;
}

/** Candidate before fact-key assignment (centroid rides along for matching). */
export type VocCandidate = Omit<CandidateFact, 'factKey'> & {
  themeLabel: string;
};

export function buildVocCandidates(input: PromotionInput): VocCandidate[] {
  const cfg = BRAND_OBJECT_CONFIG.promotion;
  const phrasesByTheme = new Map<string, PhraseForPromotion[]>();
  for (const phrase of input.phrases) {
    if (!phrase.themeId) continue;
    const list = phrasesByTheme.get(phrase.themeId);
    if (list) list.push(phrase);
    else phrasesByTheme.set(phrase.themeId, [phrase]);
  }
  const quotesByMention = new Map<string, QuoteForPromotion[]>();
  for (const quote of input.quotes) {
    const list = quotesByMention.get(quote.mentionId);
    if (list) list.push(quote);
    else quotesByMention.set(quote.mentionId, [quote]);
  }

  const candidates: VocCandidate[] = [];
  for (const theme of input.themes) {
    const section = VOC_SECTION_BY_THEME_KIND[theme.kind];
    // Catch-alls ("Other pains") are leftovers, not durable facts; only
    // brand-scope themes promote (category themes are ambient market voice).
    if (!section || theme.isCatchall || theme.scope !== 'brand') continue;
    const members = phrasesByTheme.get(theme.id) ?? [];
    if (members.length === 0) continue;

    const centroid = meanVector(
      members.map((m) => m.vector ?? []).filter((v) => v.length > 0),
    );
    // Nearest-to-centroid ordering makes evidence and match-phrase picks
    // deterministic and representative.
    const ordered = centroid
      ? [...members].sort(
          (a, b) =>
            cosineSimilarity(b.vector ?? [], centroid) -
            cosineSimilarity(a.vector ?? [], centroid),
        )
      : members;

    const metrics = computeVocMetrics(ordered, input.mentionById, input.now);
    const evidence = buildVocEvidence(
      theme,
      ordered,
      quotesByMention,
      input.mentionById,
    );

    candidates.push({
      section,
      statement: theme.summary?.trim() || theme.label,
      details: {
        label: theme.label,
        summary: theme.summary,
        themeKind: theme.kind,
        // Next promotion recomputes this fact's centroid from these phrase
        // embeddings (phrases are never deleted, ids stable).
        matchPhraseIds: ordered
          .slice(0, cfg.matchPhraseCap)
          .map((m) => m.id),
      },
      confidence: vocConfidence(metrics.frequency ?? 0),
      source: 'voc_promotion',
      evidence,
      metrics,
      centroid,
      themeLabel: theme.label,
    });
  }
  // Note: the per-section slice may reorder candidates across sections; the
  // processor keys and reconciles per section, so order between sections is
  // immaterial.
  return capVocCandidatesPerSection(candidates, cfg.maxFactsPerVocSection);
}

/**
 * Keep the top-N candidates per VOC section by compareVocRank
 * (decayedFrequency desc, frequency desc, label asc) — a founder can review
 * ~12 facts per kind, not 30. Retrieval quality is unaffected: ranked-out
 * themes are low-frequency tails whose confidence already buries them.
 */
export function capVocCandidatesPerSection(
  candidates: VocCandidate[],
  cap: number,
): VocCandidate[] {
  const bySection = new Map<string, VocCandidate[]>();
  for (const candidate of candidates) {
    const list = bySection.get(candidate.section);
    if (list) list.push(candidate);
    else bySection.set(candidate.section, [candidate]);
  }
  const kept: VocCandidate[] = [];
  for (const list of bySection.values()) {
    kept.push(
      ...list
        .sort((a, b) =>
          compareVocRank(
            { metrics: a.metrics, rankLabel: a.themeLabel },
            { metrics: b.metrics, rankLabel: b.themeLabel },
          ),
        )
        .slice(0, cap),
    );
  }
  return kept;
}

/** Deterministic confidence from evidence volume — never 1.0 (reserved for
 * the founder). 3 phrases ≈ 0.62, 10 ≈ 0.8, caps at 0.9. */
export function vocConfidence(frequency: number): number {
  return Math.round(Math.min(0.9, 0.5 + frequency * 0.04) * 100) / 100;
}

function computeVocMetrics(
  members: PhraseForPromotion[],
  mentionById: Map<string, MentionForPromotion>,
  now: Date,
) {
  const halfLifeMs =
    BRAND_OBJECT_CONFIG.promotion.decayHalfLifeDays * 24 * 60 * 60 * 1000;
  const perPlatform: Record<string, number> = {};
  let decayed = 0;
  let lastSeenAt: string | null = null;
  for (const member of members) {
    const mention = mentionById.get(member.mentionId);
    const platform = mention?.platform ?? 'unknown';
    perPlatform[platform] = (perPlatform[platform] ?? 0) + 1;
    const postedAt = mention?.postedAt ? Date.parse(mention.postedAt) : NaN;
    const ageMs = Number.isFinite(postedAt)
      ? Math.max(0, now.getTime() - postedAt)
      : 0;
    decayed += Math.pow(0.5, ageMs / halfLifeMs);
    if (
      mention?.postedAt &&
      (!lastSeenAt || mention.postedAt > lastSeenAt)
    ) {
      lastSeenAt = mention.postedAt;
    }
  }
  return {
    frequency: members.length,
    decayedFrequency: Math.round(decayed * 100) / 100,
    perPlatform,
    lastSeenAt,
  };
}

const foldForMatch = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Ad Lab: the quote and the phrase overlap (one contains the other), ignoring case and spacing. */
function quoteSaysPhrase(quote: string, phrase: string): boolean {
  const q = foldForMatch(quote);
  const p = foldForMatch(phrase);
  return q.length > 0 && p.length > 0 && (q.includes(p) || p.includes(q));
}

function buildVocEvidence(
  theme: ThemeForPromotion,
  orderedMembers: PhraseForPromotion[],
  quotesByMention: Map<string, QuoteForPromotion[]>,
  mentionById: Map<string, MentionForPromotion>,
): EvidenceRef[] {
  const cfg = BRAND_OBJECT_CONFIG.promotion;
  const evidence: EvidenceRef[] = [
    // Theme id is unstable across rebuilds — recorded as provenance of THIS
    // promotion pass, never used for identity.
    { type: 'theme_snapshot', id: theme.id, count: orderedMembers.length },
  ];
  for (const member of orderedMembers.slice(0, cfg.matchPhraseCap)) {
    const mention = mentionById.get(member.mentionId);
    evidence.push({
      type: 'phrase',
      id: member.id,
      platform: mention?.platform,
      url: mention?.url ?? undefined,
    });
  }
  // Verbatims: prefer quotes from the mentions closest to the centroid.
  // Quotes were mechanically substring-verified at extraction; render-safe.
  // A mention in another language still COUNTS toward the theme — it is only
  // never quoted, because every reader of the quote is in the merchant's
  // language (see `quote-language.ts`).
  // Ad Lab: a mention's quotes can be about different things (one review
  // complains about taste, billing and support), so quote the one that says
  // this member's phrase, not the mention's first. A mention with no such
  // quote is skipped; a later member from it may still have one.
  let verbatims = 0;
  const seenMentions = new Set<string>();
  for (const member of orderedMembers) {
    if (verbatims >= cfg.verbatimCap) break;
    if (seenMentions.has(member.mentionId)) continue;
    const quote = quotesByMention
      .get(member.mentionId)
      ?.find(
        (candidate) =>
          quoteSaysPhrase(candidate.phrase, member.phrase) &&
          isQuoteInMerchantLanguage(candidate.phrase),
      );
    if (!quote) continue;
    seenMentions.add(member.mentionId);
    const mention = mentionById.get(member.mentionId);
    evidence.push({
      type: 'phrase',
      id: quote.id,
      quote: quote.phrase,
      platform: mention?.platform,
      url: mention?.url ?? undefined,
    });
    verbatims++;
  }
  return evidence;
}

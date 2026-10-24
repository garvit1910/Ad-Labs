/**
 * Pure selectors for the Brand Identity combined insights dashboard. The
 * Brand Object already IS the distillation of both upstream streams —
 * `market_prior` facts come from winner-gated competitor ads (Layer 1),
 * `voc_*` facts from brand-presence listening (Layer 2) — so the dashboard is
 * a deterministic render of live facts plus thin L1/L2 headline stats. ZERO
 * LLM, zero IO: every function here is pure over already-fetched data, and
 * every fallback is null-tolerant (a loading/errored stat hook degrades a
 * tile, never blanks the dashboard). `details` arrives as untyped JSONB —
 * selectors narrow defensively and drop malformed rows.
 */
import type {
  AwarenessStage,
  BrandSection,
  EvidenceRef,
  FactMetrics,
} from './types';
import { marketEvidenceAge } from './freshness';
import { personaVerbatimKey, pickPersonaVerbatim } from './personas/verbatim-rank';
import { compareVocRank } from './voc-rank';
import { pickVocVerbatim } from './voc-verbatim';

/** Structural input satisfied by hooks' BrandFactView — no hooks/ import. */
export interface InsightFact {
  id: string;
  section: BrandSection;
  fact_key: string;
  statement: string;
  details: Record<string, unknown>;
  confidence: number;
  status: 'candidate' | 'confirmed';
  evidence: EvidenceRef[];
  metrics: FactMetrics;
  /** brand_facts.updated_at when the caller selected it (the facts route
   * does) — the fallback evidence date behind `metrics.evidenceAsOf`. */
  updated_at?: string;
}

/** Deep-link targets — one place to retarget if routes move again. */
export const INSIGHT_LINKS = {
  market: '/brand-identity/competitor-analysis',
  presence: '/brand-identity/presence',
  identity: '#identity',
} as const;

/** Presentation mode for the Brand Identity report. */
export type ReportTreatment = 'classic' | 'distilled';

/** Character cap for headline surfaces that must hold one line (the market
 * rail, compliance rows, alignment card labels). */
export const CLAIM_HEADLINE_MAX_LENGTH = 64;

/** Short display headline for a claim statement: text up to the first
 * sentence terminator (. ! ?), " — " em-dash clause break, or semicolon;
 * capped at `maxLength` chars on a word boundary with a trailing ellipsis.
 * Pass `maxLength: null` where the surface can wrap (the chapter-01 pillar
 * cards) so the line is always a COMPLETE clause — a mid-sentence ellipsis in
 * a card that has room to wrap reads as data loss, not as concision.
 * Deterministic, no LLM — the distilled treatment's surface line. */
export function claimHeadline(
  statement: string,
  {
    maxLength = CLAIM_HEADLINE_MAX_LENGTH,
  }: { maxLength?: number | null } = {},
): string {
  const trimmed = statement.trim();
  const terminator = /[.!?](?= |$)| — |;/.exec(trimmed);
  const firstClause = terminator ? trimmed.slice(0, terminator.index) : trimmed;
  const headline = firstClause.length > 0 ? firstClause : trimmed;

  if (maxLength === null || headline.length <= maxLength) return headline;

  const boundary = headline.slice(0, maxLength).lastIndexOf(' ');
  const end = boundary > 0 ? boundary : maxLength - 1;
  return `${headline.slice(0, end)}…`;
}

/** Leading traits in a voice statement are single adjectives; only the trailing
 * qualifier is allowed to run long ("…benefit-led with a modern wellness
 * angle"). A longer leading part means the statement is prose, not a list. */
const MAX_VOICE_TRAIT_WORDS = 3;
const MAX_VOICE_TAIL_WORDS = 8;

/** Split a voice claim ("Playful, nostalgic, confident, and benefit-led with a
 * modern wellness angle.") into its individual qualities for pill rendering.
 * Deterministic, no LLM. A statement that doesn't read as a comma/and list —
 * prose such as "The brand speaks in a warm, direct tone" — is returned whole
 * so the rail never shreds a sentence into meaningless fragments. */
export function voiceTraits(statement: string): string[] {
  const trimmed = statement.trim().replace(/[.\s]+$/, '');
  if (trimmed.length === 0) return [];

  const parts = trimmed
    .split(/\s*,\s*|\s+(?:and|&)\s+/i)
    // ", and x" leaves the conjunction on the following part.
    .map((part) => part.replace(/^(?:and|&)\s+/i, '').trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) return [trimmed];

  const wordCount = (part: string) => part.split(/\s+/).length;
  const listShaped =
    parts
      .slice(0, -1)
      .every((part) => wordCount(part) <= MAX_VOICE_TRAIT_WORDS) &&
    wordCount(parts[parts.length - 1]) <= MAX_VOICE_TAIL_WORDS;
  if (!listShaped) return [trimmed];

  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1));
}

/** Humanize a raw dimension/tag token for display: underscores → spaces and
 * sentence case (e.g. `hook_archetype` → `Hook archetype`). Deterministic, no
 * LLM — used wherever raw tag values would otherwise render with underscores. */
export function humanizeTagValue(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  if (spaced.length === 0) return spaced;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ── Market priors ────────────────────────────────────────────────────────────

/** `angle` is the industry-specific vocabulary (market.ts PRIOR_DIMENSIONS);
 * the angle group also accepts legacy `angle_universal` rows so a confirmed
 * pre-migration prior keeps rendering until it is superseded. */
export const INSIGHT_PRIOR_DIMENSIONS = [
  { key: 'angle', label: 'Angle' },
  { key: 'hook_archetype', label: 'Hook' },
  { key: 'format', label: 'Format' },
  { key: 'offer_type', label: 'Offer' },
] as const;
export type PriorDimensionKey = (typeof INSIGHT_PRIOR_DIMENSIONS)[number]['key'];

export interface MarketPriorRow {
  factId: string;
  value: string;
  statement: string;
  share: number;
  conceptCount: number;
  totalConcepts: number;
  replicationWeight: number;
  /** replicationWeight / dimension max × 100 — drives the div bar width. */
  barPct: number;
  /** ISO evidence date behind this prior (lib/brand-object/freshness.ts);
   * null when neither metrics.evidenceAsOf nor updated_at resolved. */
  evidenceAsOf?: string | null;
  /** Evidence older than MARKET_EVIDENCE_STALE_AFTER_DAYS. */
  evidenceStale?: boolean;
}

export interface PriorDimensionGroup {
  key: PriorDimensionKey;
  label: string;
  rows: MarketPriorRow[];
}

/**
 * market_prior facts grouped by details.dimension, ranked by
 * replicationWeight desc (tie: winnerCount desc, then value asc). Malformed
 * details drop the row; empty dimensions are omitted.
 */
export function priorsByDimension(facts: InsightFact[]): PriorDimensionGroup[] {
  const groups: PriorDimensionGroup[] = [];
  for (const dimension of INSIGHT_PRIOR_DIMENSIONS) {
    const rows: Array<MarketPriorRow & { legacy?: boolean }> = [];
    for (const fact of facts) {
      if (fact.section !== 'market_prior') continue;
      const details = fact.details ?? {};
      const legacyAngle =
        dimension.key === 'angle' && details.dimension === 'angle_universal';
      if (details.dimension !== dimension.key && !legacyAngle) continue;
      if (typeof details.value !== 'string' || details.value.length === 0) {
        continue;
      }
      const age = marketEvidenceAge(fact);
      rows.push({
        factId: fact.id,
        value: details.value,
        statement: fact.statement,
        share: typeof details.share === 'number' ? details.share : 0,
        conceptCount:
          typeof details.conceptCount === 'number' ? details.conceptCount : 0,
        totalConcepts:
          typeof details.totalConcepts === 'number' ? details.totalConcepts : 0,
        replicationWeight: fact.metrics.replicationWeight ?? 0,
        barPct: 0,
        evidenceAsOf: age.evidenceAsOf,
        evidenceStale: age.isStale,
        legacy: legacyAngle,
      });
    }
    // Once any industry-vocabulary angle prior exists, legacy universal rows
    // hide (a confirmed legacy prior must not duplicate a migrated value).
    const migrated = rows.some((row) => !row.legacy);
    const kept = rows
      .filter((row) => (migrated ? !row.legacy : true))
      .map(({ legacy: _legacy, ...row }) => row);
    if (kept.length === 0) continue;
    kept.sort((a, b) => {
      const rep = b.replicationWeight - a.replicationWeight;
      if (rep !== 0) return rep;
      const concepts = b.conceptCount - a.conceptCount;
      if (concepts !== 0) return concepts;
      return a.value.localeCompare(b.value);
    });
    const max = kept[0].replicationWeight;
    for (const row of kept) {
      row.barPct = max > 0 ? Math.round((row.replicationWeight / max) * 100) : 0;
    }
    groups.push({ key: dimension.key, label: dimension.label, rows: kept });
  }
  return groups;
}

// ── Market formula (Chapter 04 render model) ─────────────────────────────────

/**
 * Narrative order for the Chapter 04 formula strip — the order an ad is
 * actually built in, which is deliberately NOT the fact order in
 * INSIGHT_PRIOR_DIMENSIONS. A dimension missing from this list still renders,
 * appended in `priorsByDimension` order rather than silently vanishing.
 */
const FORMULA_ORDER: readonly PriorDimensionKey[] = [
  'hook_archetype',
  'angle',
  'format',
  'offer_type',
];

/** Fixed noun frame the winner slots into — never a reworded value. */
const FORMULA_NOUN: Record<PriorDimensionKey, string> = {
  hook_archetype: 'hook',
  angle: 'angle',
  format: 'format',
  offer_type: 'offer',
};

export interface MarketFormulaSegment extends MarketPriorRow {
  /** replicationWeight ÷ dimension total × 100 — exact, so widths sum to 100. */
  sharePct: number;
  /** Tied at the dimension's top replication weight. */
  isWinner: boolean;
}

export interface MarketFormulaStep {
  key: PriorDimensionKey;
  label: string;
  /** Singular noun for copy frames ("44% of hook proof"). */
  noun: string;
  /** Every row, in `priorsByDimension` rank order, with its share. */
  segments: MarketFormulaSegment[];
  /** Rows tied at the top replication weight — length ≥ 2 is a real tie. */
  winners: MarketFormulaSegment[];
  /** Humanized winner value(s), joined for ties — the formula chip. */
  winnerLabel: string;
  /** Combined winner share, rounded — the donut number. */
  winnerSharePct: number;
  /** Combined winner replication weight and concept count. */
  winnerWeight: number;
  winnerConcepts: number;
  /** Dimension total replication weight — the share denominator. */
  totalWeight: number;
  /** Deterministic headline — pure arithmetic over the facts, zero LLM. */
  headline: string;
  /** `headline` as a template code + its inputs (winner names are humanized
   * tag values — data), so a client can render it in the user's language.
   * The noun comes from `key`. */
  headlineCopy: MarketFormulaHeadlineCopy;
}

export type MarketFormulaHeadlineCopy =
  | { code: 'none' }
  | { code: 'tie'; count: number; weight: number }
  | { code: 'pair'; first: string; second: string; pct: number }
  | { code: 'majority'; name: string; pct: number }
  | { code: 'carries'; name: string; pct: number };

/**
 * Chapter 04's render model: each prior dimension reduced to its modal winner
 * plus the full share-of-proof distribution behind it. Every number is a
 * ratio of replication weights the distillation already computed, and every
 * headline is a template over those ratios — the chapter's "zero AI
 * judgment" caption stays literally true.
 */
export function marketFormula(
  groups: PriorDimensionGroup[],
): MarketFormulaStep[] {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const ordered = [
    ...FORMULA_ORDER.map((key) => byKey.get(key)),
    ...groups.filter((group) => !FORMULA_ORDER.includes(group.key)),
  ].filter(
    (group): group is PriorDimensionGroup =>
      group != null && group.rows.length > 0,
  );

  return ordered.map((group) => {
    const totalWeight = group.rows.reduce(
      (sum, row) => sum + row.replicationWeight,
      0,
    );
    const topWeight = group.rows[0].replicationWeight;
    const segments: MarketFormulaSegment[] = group.rows.map((row) => ({
      ...row,
      sharePct:
        totalWeight > 0 ? (row.replicationWeight / totalWeight) * 100 : 0,
      // An all-zero dimension has no winner to crown: the first row still
      // leads on the existing tiebreak, but nothing "ties" with it.
      isWinner: topWeight > 0 && row.replicationWeight === topWeight,
    }));
    const winners = segments.filter((segment) => segment.isWinner);
    const lead = winners.length > 0 ? winners : segments.slice(0, 1);
    const winnerSharePct = Math.round(
      lead.reduce((sum, segment) => sum + segment.sharePct, 0),
    );
    const noun = FORMULA_NOUN[group.key];

    return {
      key: group.key,
      label: group.label,
      noun,
      segments,
      winners: lead,
      winnerLabel: lead
        .map((segment) => humanizeTagValue(segment.value))
        .join(' + '),
      winnerSharePct,
      winnerWeight: lead.reduce(
        (sum, segment) => sum + segment.replicationWeight,
        0,
      ),
      winnerConcepts: lead.reduce(
        (sum, segment) => sum + segment.conceptCount,
        0,
      ),
      totalWeight,
      ...formulaHeadline(lead, winnerSharePct, noun, topWeight),
    };
  });
}

function formulaHeadline(
  lead: MarketFormulaSegment[],
  sharePct: number,
  noun: string,
  topWeight: number,
): { headline: string; headlineCopy: MarketFormulaHeadlineCopy } {
  if (topWeight <= 0) {
    return {
      headline: `No replication recorded for ${noun}s yet`,
      headlineCopy: { code: 'none' },
    };
  }
  const names = lead.map((segment) => humanizeTagValue(segment.value));
  if (names.length >= 3) {
    return {
      headline: `${names.length} ${noun} patterns tie at rep. ${topWeight}, no clear winner`,
      headlineCopy: { code: 'tie', count: names.length, weight: topWeight },
    };
  }
  if (names.length === 2) {
    return {
      headline: `${names[0]} and ${names[1]} tie, together ${sharePct}% of ${noun} proof`,
      headlineCopy: { code: 'pair', first: names[0], second: names[1], pct: sharePct },
    };
  }
  if (sharePct > 50) {
    return {
      headline: `${names[0]} is the majority: ${sharePct}% of ${noun} proof`,
      headlineCopy: { code: 'majority', name: names[0], pct: sharePct },
    };
  }
  return {
    headline: `${names[0]} carries ${sharePct}% of ${noun} proof`,
    headlineCopy: { code: 'carries', name: names[0], pct: sharePct },
  };
}

// ── Customer voice ───────────────────────────────────────────────────────────

export type VocSection = 'voc_pain' | 'voc_desire' | 'voc_objection' | 'voc_praise';
const VOC_SECTIONS: readonly VocSection[] = [
  'voc_pain',
  'voc_desire',
  'voc_objection',
  'voc_praise',
];

export interface VocInsightRow {
  factId: string;
  section: VocSection;
  label: string;
  statement: string;
  frequency: number;
  decayedFrequency: number;
  /** perPlatform sorted desc, capped at 3 chips. */
  platforms: Array<{ platform: string; count: number }>;
  /**
   * The theme's best evidence quote (`voc-verbatim.ts`) — substring-verified
   * at write time, null when every stored quote is a fragment or an advert.
   */
  verbatim: string | null;
}

/** Top-k per VOC section by compareVocRank (same order as the review digest). */
export function topVocBySection(
  facts: InsightFact[],
  k = 3,
): Partial<Record<VocSection, VocInsightRow[]>> {
  const out: Partial<Record<VocSection, VocInsightRow[]>> = {};
  for (const section of VOC_SECTIONS) {
    const rows = facts
      .filter((fact): fact is InsightFact => fact.section === section)
      .sort((a, b) =>
        compareVocRank(
          { metrics: a.metrics, rankLabel: vocLabel(a) },
          { metrics: b.metrics, rankLabel: vocLabel(b) },
        ),
      )
      .slice(0, k)
      .map((fact) => {
        const label = vocLabel(fact);
        return {
          factId: fact.id,
          section,
          label,
          statement: fact.statement,
          frequency: fact.metrics.frequency ?? 0,
          decayedFrequency: fact.metrics.decayedFrequency ?? 0,
          platforms: Object.entries(fact.metrics.perPlatform ?? {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([platform, count]) => ({ platform, count })),
          verbatim: pickVocVerbatim(
            fact.evidence.map((ref) => ref.quote),
            label,
          ),
        };
      });
    if (rows.length > 0) out[section] = rows;
  }
  return out;
}

function vocLabel(fact: InsightFact): string {
  const label = fact.details?.label;
  return typeof label === 'string' && label.length > 0
    ? label
    : fact.statement;
}

/** Distinct platforms across all VOC facts (the "K platforms" tile stat). */
export function distinctVocPlatforms(facts: InsightFact[]): string[] {
  const platforms = new Set<string>();
  for (const fact of facts) {
    if (!(VOC_SECTIONS as readonly string[]).includes(fact.section)) continue;
    for (const platform of Object.keys(fact.metrics.perPlatform ?? {})) {
      platforms.add(platform);
    }
  }
  return [...platforms].sort();
}

// ── Identity claims ──────────────────────────────────────────────────────────

export interface IdentityClaimRow {
  factId: string;
  section: BrandSection;
  statement: string;
  confidence: number;
  sourceUrl: string | null;
  /** First substring-verified source sentence/quote for evidence drill-in. */
  sourceSentence: string | null;
}

/** Facts in `sections`, confidence desc (human `user_stated` facts carry 1.0,
 * so founder corrections surface first emergently), capped. */
export function identityClaims(
  facts: InsightFact[],
  sections: readonly BrandSection[],
  limit = 4,
): IdentityClaimRow[] {
  return facts
    .filter((fact) => sections.includes(fact.section))
    .sort((a, b) => {
      const confidence = b.confidence - a.confidence;
      if (confidence !== 0) return confidence;
      return a.statement.localeCompare(b.statement);
    })
    .slice(0, limit)
    .map((fact) => ({
      factId: fact.id,
      section: fact.section,
      statement: fact.statement,
      confidence: fact.confidence,
      sourceUrl: fact.evidence.find((ref) => ref.url)?.url ?? null,
      sourceSentence:
        fact.evidence.find((ref) => ref.sourceSentence)?.sourceSentence ??
        fact.evidence.find((ref) => ref.quote)?.quote ??
        null,
    }));
}

// ── Personas ─────────────────────────────────────────────────────────────────

export interface PersonaCard {
  factId: string;
  name: string;
  description: string;
  awarenessStage: AwarenessStage | null;
  /**
   * True for the unaware-projection slot: an inference extrapolated backward
   * from the grounded facts, not an observed buyer. The ladder renders it
   * with an explicit "projected" treatment — never as customer voice.
   */
  extrapolated: boolean;
  pains: string[];
  desires: string[];
  verbatim: string | null;
}

export function personaCards(facts: InsightFact[]): PersonaCard[] {
  const named = facts
    .filter((fact) => fact.section === 'persona')
    .map((fact) => {
      const details = fact.details ?? {};
      const name = typeof details.name === 'string' ? details.name : null;
      return name ? { fact, details, name } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  // A verbatim belongs to at most one card. Personas' pools overlap (the same
  // review can portray more than one buyer), so without this the ladder printed
  // one strong self-ID line under two awareness stages. Claiming runs
  // grounded-personas-first so a shared line lands on the OBSERVED buyer, never
  // on the lower-confidence unaware projection; the display order below is
  // untouched.
  const claimedVerbatims = new Set<string>();
  const verbatimByFactId = new Map<string, string | null>();
  const claimOrder = named
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Number(a.entry.details.extrapolated === true) -
          Number(b.entry.details.extrapolated === true) || a.index - b.index,
    );
  for (const { entry } of claimOrder) {
    // Model order is not quality order — rank for "shows the buyer", skip
    // already-claimed lines, and show nothing when nothing unclaimed qualifies.
    const verbatim = pickPersonaVerbatim(entry.details.verbatims, claimedVerbatims);
    if (verbatim) claimedVerbatims.add(personaVerbatimKey(verbatim));
    verbatimByFactId.set(entry.fact.id, verbatim);
  }

  return named.map(({ fact, details, name }) => ({
    factId: fact.id,
    name,
    description:
      typeof details.description === 'string' ? details.description : '',
    awarenessStage:
      typeof details.awarenessStage === 'string'
        ? (details.awarenessStage as AwarenessStage)
        : null,
    extrapolated: details.extrapolated === true,
    pains: refNotes(details.pains, 2),
    desires: refNotes(details.desires, 2),
    verbatim: verbatimByFactId.get(fact.id) ?? null,
  }));
}

function refNotes(refs: unknown, cap: number): string[] {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref) =>
      ref && typeof ref === 'object' && typeof (ref as { note?: unknown }).note === 'string'
        ? (ref as { note: string }).note
        : null,
    )
    .filter((note): note is string => note !== null)
    .slice(0, cap);
}

// ── On-screen tail chapter numbers ───────────────────────────────────────────

/**
 * Numbers for the report's two CONDITIONAL tail chapters on screen — "What's
 * working for you" (own-ad performance) and "The competitive landscape". On
 * screen the numbers are written into the dashboard JSX and the rail's jump
 * list, so both read them from here: a conditional chapter that is absent must
 * not leave a gap (07 → 09) or let the two lists disagree. Performance sits
 * first (it reads the brand's own ads, right after the personas it speaks to);
 * the landscape closes the report. Null = the chapter is not rendered.
 */
export function tailChapterNumbers({
  hasPerformance,
  hasLandscape,
}: {
  hasPerformance: boolean;
  hasLandscape: boolean;
}): { performance: string | null; landscape: string | null } {
  return {
    performance: hasPerformance ? '07' : null,
    landscape: hasLandscape ? (hasPerformance ? '08' : '07') : null,
  };
}

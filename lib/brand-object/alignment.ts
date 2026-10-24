/**
 * Chapter 05's render model — "How it all lines up".
 *
 * The first four chapters each speak for one stream: what you CLAIM (01), what
 * customers SAY (03), what the market REWARDS (04). This selector is the only
 * place they are set against each other, and it is deliberately dumb about how
 * it does it: two nodes link when their wording OVERLAPS, and nothing else.
 * There is no LLM, no embedding, and no judgment about whether a claim is
 * *true* — a link means "these two talk about the same thing", and the chapter
 * says exactly that. Every count on the panel is `.length` of one of these
 * arrays.
 *
 * The market side is ANGLES ONLY, and that is the load-bearing decision here.
 * Chapter 04's formula also carries hook, format and offer — but those are
 * craft (how an ad is delivered, shot, and promoted), not argument. Asking
 * whether a product claim "covers" a founder-talking format is a question with
 * no answer, so every such row read as an unclaimed gap and the column carried
 * no signal at all. An ANGLE is claim-shaped — a brand either makes that
 * argument or it doesn't — so it is the only market dimension this chapter can
 * honestly weigh a claim against. Hook/format/offer stay in Chapter 04.
 *
 * The market column does NOT use the word matcher. "Do you make this argument"
 * is a question about the brand's ADS, and own ads are labeled with the SAME
 * angle vocabulary the priors are distilled in, so that column is exact token
 * equality against `own-angles.ts` — see its module note for why word overlap
 * answered red almost regardless of what the brand ran. The matcher survives
 * there only to separate "claimed but never advertised" from a total absence.
 *
 * The chapter renders as FOUR columns: what you SAY (claims), what customers
 * SAY (voice), YOUR ANGLES (the brand's own advertised angle mix), and WINNING
 * ANGLES (what the market rewards). The last two are mirrors — one reads "what
 * you run, flagged by whether it wins", the other "what wins, flagged by
 * whether you run it" — which is the cleanest correlation the founder can read
 * at a glance. A deterministic, template-only `suggestions` list distills the
 * columns into next steps; it sources no number the columns did not show.
 *
 * Pure over already-fetched selector output (`insights.ts`), null-tolerant,
 * and returns null when there is nothing to align so the chapter can unmount
 * rather than render an empty grid.
 */
import {
  claimHeadline,
  humanizeTagValue,
  type IdentityClaimRow,
  type MarketFormulaStep,
  type VocInsightRow,
  type VocSection,
} from './insights';
import {
  normalizeAngleToken,
  ownAngleAdCount,
  ownAngleSharePct,
  type OwnAdAngleMix,
} from './own-angles';

/** Aligned = the two sides meet. Claimed = you say it but never run it (market
 * column only). Gap = friction nobody answers. Silent = no counterpart at all,
 * or no evidence to judge against. One legend, same words in every column. */
export type AlignmentStatus = 'aligned' | 'claimed' | 'gap' | 'silent';

/**
 * Structured twin of `AlignmentNode.note` — the same wording as a code (plus
 * its one number), so a client can render the note in the user's language.
 * `note` stays the English text every non-UI consumer reads; the two are
 * always built together.
 */
export type AlignmentNoteCopy =
  | { code: 'customers_say_it_back' }
  | { code: 'matches_winning_pattern' }
  | { code: 'customers_push_back' }
  | { code: 'nothing_echoes' }
  | { code: 'claim_answers' }
  | { code: 'you_claim_this' }
  | { code: 'no_claim_answers' }
  | { code: 'beyond_claims' }
  | { code: 'no_labeled_ads' }
  | { code: 'argue_in_ads'; count: number }
  | { code: 'claim_never_run' }
  | { code: 'ads_never_argue' }
  | { code: 'winning_angle_you_run' }
  | { code: 'not_top_pattern' };

/** Structured twin of `AlignmentNode.detail` (counts and shares only). */
export type AlignmentDetailCopy =
  | { code: 'claim_section'; section: string }
  | { code: 'voice_kind'; section: VocSection; mentions: number }
  | { code: 'market_proof'; proofPct: number }
  | { code: 'market_proof_own'; proofPct: number; ownPct: number }
  | { code: 'own_ads'; ads: number; ownPct: number };

/** Structured twin of `AlignmentSuggestion.text`: the template code, how many
 * nodes it covers, and the (capped) node labels it names — labels are data. */
export interface AlignmentSuggestionCopy {
  code:
    | 'run_winning_angles'
    | 'ship_claimed_angles'
    | 'answer_objections'
    | 'reconcile_contested_claims'
    | 'lean_into_strengths';
  count: number;
  examples: string[];
}

export interface AlignmentNode {
  id: string;
  /** Short display line — claim headline, theme label, angle name. */
  label: string;
  /** Deterministic stat under the label ("128 mentions", "38% of competitor
   * proof · 12% of your ads"). Always a ratio of counts, never a judgment. */
  detail: string | null;
  status: AlignmentStatus;
  /** Column-specific status wording ("No claim answers this"). */
  note: string;
  /** `note` as a code — for rendering in the user's language. */
  noteCopy: AlignmentNoteCopy;
  /** `detail` as a code; null exactly when `detail` is null. */
  detailCopy: AlignmentDetailCopy | null;
  /** Labels of the nodes it links to, capped — the proof of the link. */
  links: string[];
}

/** A deterministic, template-only recommendation — never an LLM sentence. The
 * `kind` drives the accent and is ALSO printed in words, so it never rests on
 * color alone. `opportunity` = something rewarded you aren't doing; `friction`
 * = something customers raise you don't answer; `strength` = keep doing it. */
export interface AlignmentSuggestion {
  id: string;
  kind: 'opportunity' | 'friction' | 'strength';
  text: string;
  /** `text` as a template code + its inputs, for the user's language. */
  copy: AlignmentSuggestionCopy;
}

export interface BrandAlignment {
  claims: AlignmentNode[];
  voice: AlignmentNode[];
  /** The brand's OWN advertised angles, ranked by share of its own ads. The
   * mirror of `market`: this column reads "what you run", flagged by whether
   * the market rewards it; `market` reads "what wins", flagged by whether you
   * run it. Empty until own ads are labeled. */
  ownAdvertised: AlignmentNode[];
  /** Winning market ANGLES — never hook/format/offer. See the module note. */
  market: AlignmentNode[];
  /** Deterministic next-step recommendations distilled from the columns. */
  suggestions: AlignmentSuggestion[];
  summary: {
    echoedClaims: number;
    totalClaims: number;
    /** Pains/objections no claim answers. */
    unansweredPressure: number;
    /** Winning angles the brand's own ads never run — a VERIFIED gap. */
    unadvertisedAngles: number;
    /** Winning angles the brand claims on its site but never runs an ad on. */
    claimedNotAdvertised: number;
    /**
     * Own ads with an angle label. Zero means the market column could not be
     * judged at all, and the panel must say so instead of reading its neutral
     * cards as a clean bill of health.
     */
    ownAdsLabeled: number;
  };
}

/** Claim nodes in the left column — beyond this the map stops being scannable. */
const MAX_CLAIMS = 5;
/** One theme per VOC kind: four balanced nodes, no bias toward praise. */
const VOICE_PER_KIND = 1;
/** Winning angles in the right column, ranked by share of competitor proof —
 * so the most-rewarded argument is always the first red the founder reads. */
const MAX_ANGLES = 4;
/** Own advertised angles in the "Your angles" column, ranked by share of the
 * brand's own ads — kept level with the winning column so the two read as a
 * pair. */
const MAX_OWN_ANGLES = 4;
/** Suggestions shown under the map, and examples named inside each one — past
 * these the block stops being a short call to action. */
const MAX_SUGGESTIONS = 4;
const MAX_SUGGESTION_EXAMPLES = 2;
/** Counterpart labels shown on a node before it starts wrapping. */
const MAX_LINKS = 2;
/** Shared content words needed to call two lines the same subject. */
const MIN_OVERLAP = 2;
/** …unless one shared word is long enough to be distinctive on its own. */
const DISTINCTIVE_LENGTH = 6;
/** A LONE shared word must at least be substantial — "taste", not "food". */
const SINGLE_WORD_LENGTH = 5;

/** Support reads as "customers agree", pressure as "customers push back". */
const SUPPORT_SECTIONS: readonly VocSection[] = ['voc_praise', 'voc_desire'];
const PRESSURE_SECTIONS: readonly VocSection[] = ['voc_pain', 'voc_objection'];
/** Display order: agreement first, then the friction. */
const VOICE_ORDER: readonly VocSection[] = [
  'voc_praise',
  'voc_desire',
  'voc_pain',
  'voc_objection',
];
const VOICE_KIND_LABEL: Record<VocSection, string> = {
  voc_praise: 'Praise',
  voc_desire: 'Desire',
  voc_pain: 'Pain',
  voc_objection: 'Objection',
};

// Words that carry no subject. Kept small on purpose: the length floor below
// already drops most function words, and an over-eager list silently breaks
// matches on real vocabulary.
const STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'they', 'them', 'their', 'your', 'yours',
  'have', 'has', 'had', 'been', 'were', 'will', 'would', 'could', 'should',
  'about', 'into', 'over', 'more', 'most', 'much', 'than', 'then', 'when',
  'what', 'which', 'while', 'where', 'because', 'also', 'just', 'like',
  'make', 'makes', 'made', 'want', 'wants', 'need', 'needs', 'every',
  'other', 'some', 'only', 'even', 'still', 'says', 'said', 'thing',
  'things', 'really', 'very', 'lot', 'get', 'gets', 'got',
  // Long function words specifically — these clear DISTINCTIVE_LENGTH and
  // would otherwise link any two lines that merely share a preposition.
  'without', 'within', 'through', 'across', 'around', 'before', 'after',
  'during', 'between', 'there', 'these', 'those', 'being', 'doing',
  'something', 'anything', 'everything', 'always', 'never',
]);
/** Below this a token is a function word far more often than a subject. */
const MIN_TOKEN_LENGTH = 4;

/**
 * Content words of a line: lowercased, punctuation-split, function words and
 * short tokens dropped, and a plural collapsed onto its singular so
 * "ingredients" matches "ingredient". Exported for the tests that pin the
 * matcher's reach.
 */
export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    // Only strip a plural that leaves a real stem — "less" must not become
    // "les", and the singular is what both sides get compared on.
    const token = raw.endsWith('s') && raw.length >= 5 ? raw.slice(0, -1) : raw;
    if (STOPWORDS.has(token) || STOPWORDS.has(raw)) continue;
    tokens.add(token);
  }
  return tokens;
}

/** Shared content words, or an empty list when the two lines aren't a match. */
function sharedSubject(a: Set<string>, b: Set<string>): string[] {
  const shared: string[] = [];
  for (const token of a) if (b.has(token)) shared.push(token);
  if (shared.length === 0) return [];

  // One long, specific word ("ingredient", "subscription") stands on its own.
  if (shared.some((token) => token.length >= DISTINCTIVE_LENGTH)) return shared;

  // Otherwise the bar is RELATIVE to the shorter line. A theme label like
  // "Bad taste" carries exactly one content word, so a flat two-word bar made
  // it structurally impossible to ever match — it is not a weak signal, it is
  // an unreachable one. A short line matching in FULL is as strong as a long
  // line matching twice.
  const required = Math.min(MIN_OVERLAP, a.size, b.size);
  if (shared.length < required) return [];
  // …but a lone short word is coincidence, not subject.
  if (shared.length === 1 && shared[0].length < SINGLE_WORD_LENGTH) return [];
  return shared;
}

interface Matchable {
  id: string;
  label: string;
  tokens: Set<string>;
}

/** Ids in `right` that share a subject with `left`, best overlap first. */
function linkTargets(left: Matchable, right: Matchable[]): Matchable[] {
  return right
    .map((candidate) => ({
      candidate,
      shared: sharedSubject(left.tokens, candidate.tokens).length,
    }))
    .filter((entry) => entry.shared > 0)
    .sort((a, b) => {
      const shared = b.shared - a.shared;
      if (shared !== 0) return shared;
      return a.candidate.label.localeCompare(b.candidate.label);
    })
    .map((entry) => entry.candidate);
}

function labelsOf(nodes: Matchable[]): string[] {
  return nodes.slice(0, MAX_LINKS).map((node) => node.label);
}

/** The capped examples one suggestion names (also its `copy.examples`). */
function exampleLabels(labels: string[]): string[] {
  return labels.slice(0, MAX_SUGGESTION_EXAMPLES);
}

/** "A", "A and B", "A, B and C" — the examples named inside one suggestion. */
function joinLabels(labels: string[]): string {
  const shown = exampleLabels(labels);
  if (shown.length <= 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * Set the three streams against each other. `claims` and `market` arrive
 * already ranked by their own selectors; `voc` is the full per-section map
 * (`topVocBySection(facts, Infinity)`) and is sampled one theme per kind.
 *
 * Returns null when there is nothing to align — no claims at all, or claims
 * with neither customer voice nor market priors to weigh them against.
 */
export function brandAlignment({
  claims,
  voc,
  market,
  ownAngles = null,
}: {
  claims: IdentityClaimRow[];
  voc: Partial<Record<VocSection, VocInsightRow[]>>;
  market: MarketFormulaStep[];
  /** The brand's own labeled ad angle mix. Null (or zero ads) keeps the market
   * column neutral — an unmeasured angle is not an unargued one. */
  ownAngles?: OwnAdAngleMix | null;
}): BrandAlignment | null {
  const claimSide: Matchable[] = claims.slice(0, MAX_CLAIMS).map((claim) => ({
    id: claim.factId,
    label: claimHeadline(claim.statement),
    tokens: contentTokens(claim.statement),
  }));

  const voiceRows = VOICE_ORDER.flatMap((section) =>
    (voc[section] ?? []).slice(0, VOICE_PER_KIND).map((row) => ({ section, row })),
  );
  const voiceSide: Matchable[] = voiceRows.map(({ row }) => ({
    id: row.factId,
    label: row.label,
    tokens: contentTokens(`${row.label} ${row.statement}`),
  }));

  // ANGLES ONLY — the one market dimension that argues something a claim can
  // argue back. Ranked by share of angle proof, which `marketFormula` already
  // ordered; a tie is two separate cards here rather than one joined label,
  // because each argument is separately claimable.
  const angles = (market.find((step) => step.key === 'angle')?.segments ?? [])
    .slice(0, MAX_ANGLES)
    .map((segment) => ({ segment, label: humanizeTagValue(segment.value) }));
  const marketSide: Matchable[] = angles.map(({ segment, label }) => ({
    id: segment.factId,
    label,
    tokens: contentTokens(label),
  }));

  if (claimSide.length === 0) return null;
  if (voiceSide.length === 0 && marketSide.length === 0) return null;

  const supportSide = voiceSide.filter((_, index) =>
    SUPPORT_SECTIONS.includes(voiceRows[index].section),
  );
  const pressureSide = voiceSide.filter((_, index) =>
    PRESSURE_SECTIONS.includes(voiceRows[index].section),
  );

  const claimNodes: AlignmentNode[] = claimSide.map((claim, index) => {
    const support = linkTargets(claim, supportSide);
    const rewarded = linkTargets(claim, marketSide);
    const pressure = linkTargets(claim, pressureSide);
    const source = claims[index];

    if (support.length > 0) {
      return {
        id: claim.id,
        label: claim.label,
        detail: source.section.replace(/_/g, ' '),
        detailCopy: { code: 'claim_section', section: source.section },
        status: 'aligned',
        note: 'Customers say it back',
        noteCopy: { code: 'customers_say_it_back' },
        links: labelsOf(support),
      };
    }
    if (rewarded.length > 0) {
      return {
        id: claim.id,
        label: claim.label,
        detail: source.section.replace(/_/g, ' '),
        detailCopy: { code: 'claim_section', section: source.section },
        status: 'aligned',
        note: 'Matches a winning pattern',
        noteCopy: { code: 'matches_winning_pattern' },
        links: labelsOf(rewarded),
      };
    }
    if (pressure.length > 0) {
      return {
        id: claim.id,
        label: claim.label,
        detail: source.section.replace(/_/g, ' '),
        detailCopy: { code: 'claim_section', section: source.section },
        status: 'gap',
        note: 'Customers push back on this',
        noteCopy: { code: 'customers_push_back' },
        links: labelsOf(pressure),
      };
    }
    return {
      id: claim.id,
      label: claim.label,
      detail: source.section.replace(/_/g, ' '),
      detailCopy: { code: 'claim_section', section: source.section },
      status: 'silent',
      note: 'Nothing echoes this yet',
      noteCopy: { code: 'nothing_echoes' },
      links: [],
    };
  });

  const voiceNodes: AlignmentNode[] = voiceSide.map((voice, index) => {
    const { section, row } = voiceRows[index];
    const matched = linkTargets(voice, claimSide);
    const isPressure = PRESSURE_SECTIONS.includes(section);
    const detail = `${VOICE_KIND_LABEL[section]} · ${row.frequency} mention${
      row.frequency === 1 ? '' : 's'
    }`;
    const detailCopy: AlignmentDetailCopy = {
      code: 'voice_kind',
      section,
      mentions: row.frequency,
    };

    if (matched.length > 0) {
      return {
        id: voice.id,
        label: voice.label,
        detail,
        detailCopy,
        status: 'aligned',
        note: isPressure ? 'A claim answers this' : 'You claim this',
        noteCopy: { code: isPressure ? 'claim_answers' : 'you_claim_this' },
        links: labelsOf(matched),
      };
    }
    return {
      id: voice.id,
      label: voice.label,
      detail,
      detailCopy,
      status: isPressure ? 'gap' : 'silent',
      note: isPressure ? 'No claim answers this' : 'Beyond anything you claim',
      noteCopy: { code: isPressure ? 'no_claim_answers' : 'beyond_claims' },
      links: [],
    };
  });

  // An angle is an ARGUMENT, so the wording asks whether the brand MAKES it —
  // never whether a claim "covers" it, which is the question that made
  // hook/format/offer read as nonsense. And "makes it" is settled by the ads,
  // by exact tag equality in the shared angle vocabulary: both figures on a
  // card are a ratio of counts, so the chapter's "zero AI judgment" caption
  // gets stronger, not weaker.
  const labeledAds = ownAngles?.totalLabeledAds ?? 0;
  const marketNodes: AlignmentNode[] = marketSide.map((angle, index) => {
    const { segment } = angles[index];
    const proofPct = Math.round(segment.sharePct);
    const proof = `${proofPct}% of competitor proof`;
    const proofCopy: AlignmentDetailCopy = { code: 'market_proof', proofPct };

    // No labeled own ads = no evidence either way. Four unearned reds read as
    // a strategy failure when the real state is "we haven't looked yet".
    if (labeledAds === 0) {
      return {
        id: angle.id,
        label: angle.label,
        detail: proof,
        detailCopy: proofCopy,
        status: 'silent',
        note: 'No labeled ads to compare yet',
        noteCopy: { code: 'no_labeled_ads' },
        links: [],
      };
    }

    const adCount = ownAngleAdCount(ownAngles, segment.value);
    if (adCount > 0) {
      return {
        id: angle.id,
        label: angle.label,
        detail: `${proof} · ${ownAngleSharePct(ownAngles, segment.value)}% of your ads`,
        detailCopy: {
          code: 'market_proof_own',
          proofPct,
          ownPct: ownAngleSharePct(ownAngles, segment.value),
        },
        status: 'aligned',
        note: `You argue this in ${adCount} ${adCount === 1 ? 'ad' : 'ads'}`,
        noteCopy: { code: 'argue_in_ads', count: adCount },
        links: [],
      };
    }

    // Not in the ads — but the site may still say it. That is a different
    // problem (unshipped positioning, not a blind spot), so it is its own
    // state rather than a red the founder cannot act on.
    const claimed = linkTargets(angle, claimSide);
    if (claimed.length > 0) {
      return {
        id: angle.id,
        label: angle.label,
        detail: proof,
        detailCopy: proofCopy,
        status: 'claimed',
        note: 'You claim this but never run it',
        noteCopy: { code: 'claim_never_run' },
        links: labelsOf(claimed),
      };
    }
    return {
      id: angle.id,
      label: angle.label,
      detail: proof,
      detailCopy: proofCopy,
      status: 'gap',
      note: 'Your ads never make this argument',
      noteCopy: { code: 'ads_never_argue' },
      links: [],
    };
  });

  // "Your angles" — the MIRROR of the winning column. Where `market` lists
  // what wins and flags whether you run it, this lists what you run and flags
  // whether it wins. A "winning" angle is one in the market's top segments;
  // the match is exact token equality on the industry vocabulary both sides
  // already share (a legacy universal-keyed prior is the one case this can
  // miss — it is rare and only under-credits, never over-credits). The column
  // stays empty until own ads are labeled, the same evidence gate the winning
  // column already carries.
  const winningLabelByToken = new Map<string, string>();
  for (const { segment, label } of angles) {
    winningLabelByToken.set(normalizeAngleToken(segment.value), label);
  }
  const ownIndex =
    ownAngles && Object.keys(ownAngles.byAngle).length > 0
      ? ownAngles.byAngle
      : ownAngles?.byUniversal ?? {};
  const ownAdvertisedNodes: AlignmentNode[] =
    labeledAds === 0
      ? []
      : Object.entries(ownIndex)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, MAX_OWN_ANGLES)
          .map(([token, count]) => {
            const sharePct = Math.round((count / labeledAds) * 100);
            const detail = `${count} ${count === 1 ? 'ad' : 'ads'} · ${sharePct}% of your ads`;
            const detailCopy: AlignmentDetailCopy = {
              code: 'own_ads',
              ads: count,
              ownPct: sharePct,
            };
            const winningLabel = winningLabelByToken.get(token);
            if (winningLabel) {
              return {
                id: `own-${token}`,
                label: humanizeTagValue(token),
                detail,
                detailCopy,
                status: 'aligned' as const,
                note: 'A winning angle you run',
                noteCopy: { code: 'winning_angle_you_run' as const },
                links: [winningLabel],
              };
            }
            return {
              id: `own-${token}`,
              label: humanizeTagValue(token),
              detail,
              detailCopy,
              status: 'silent' as const,
              note: 'Not a top market pattern',
              noteCopy: { code: 'not_top_pattern' as const },
              links: [],
            };
          });

  // Deterministic recommendations — template strings over the SAME nodes,
  // never an LLM sentence and never a number the columns did not already show.
  // Actionable items first, one "keep doing it" last; capped so the block
  // stays a short call to action.
  const suggestions: AlignmentSuggestion[] = [];
  const unrunWinners = marketNodes.filter((node) => node.status === 'gap');
  if (unrunWinners.length > 0) {
    suggestions.push({
      id: 'run-winning-angles',
      kind: 'opportunity',
      text: `Run the winning angle${unrunWinners.length === 1 ? '' : 's'} your ads skip: ${joinLabels(
        unrunWinners.map((node) => node.label),
      )}. The market rewards ${unrunWinners.length === 1 ? 'it' : 'them'} and your ads stay silent.`,
      copy: {
        code: 'run_winning_angles',
        count: unrunWinners.length,
        examples: exampleLabels(unrunWinners.map((node) => node.label)),
      },
    });
  }
  const claimedNotRun = marketNodes.filter((node) => node.status === 'claimed');
  if (claimedNotRun.length > 0) {
    suggestions.push({
      id: 'ship-claimed-angles',
      kind: 'opportunity',
      text: `You already claim ${joinLabels(
        claimedNotRun.map((node) => node.label),
      )} on your site. Ship it as an ad, since it is a proven winning angle.`,
      copy: {
        code: 'ship_claimed_angles',
        count: claimedNotRun.length,
        examples: exampleLabels(claimedNotRun.map((node) => node.label)),
      },
    });
  }
  const unanswered = voiceNodes.filter((node) => node.status === 'gap');
  if (unanswered.length > 0) {
    suggestions.push({
      id: 'answer-objections',
      kind: 'friction',
      text: `Answer the objection${unanswered.length === 1 ? '' : 's'} nothing you say addresses: ${joinLabels(
        unanswered.map((node) => node.label),
      )}.`,
      copy: {
        code: 'answer_objections',
        count: unanswered.length,
        examples: exampleLabels(unanswered.map((node) => node.label)),
      },
    });
  }
  const contested = claimNodes.filter((node) => node.status === 'gap');
  if (contested.length > 0) {
    suggestions.push({
      id: 'reconcile-contested-claims',
      kind: 'friction',
      text: `Customers push back on ${joinLabels(
        contested.map((node) => node.label),
      )}. Reconcile the promise with what they experience.`,
      copy: {
        code: 'reconcile_contested_claims',
        count: contested.length,
        examples: exampleLabels(contested.map((node) => node.label)),
      },
    });
  }
  const landing = claimNodes.filter((node) => node.status === 'aligned');
  if (landing.length > 0) {
    suggestions.push({
      id: 'lean-into-strengths',
      kind: 'strength',
      text: `Lean into what already lands: ${joinLabels(
        landing.map((node) => node.label),
      )} meet${landing.length === 1 ? 's' : ''} customers or the market.`,
      copy: {
        code: 'lean_into_strengths',
        count: landing.length,
        examples: exampleLabels(landing.map((node) => node.label)),
      },
    });
  }

  return {
    claims: claimNodes,
    voice: voiceNodes,
    ownAdvertised: ownAdvertisedNodes,
    market: marketNodes,
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
    summary: {
      echoedClaims: claimNodes.filter((node) => node.status === 'aligned').length,
      totalClaims: claimNodes.length,
      unansweredPressure: voiceNodes.filter((node) => node.status === 'gap').length,
      unadvertisedAngles: marketNodes.filter((node) => node.status === 'gap')
        .length,
      claimedNotAdvertised: marketNodes.filter(
        (node) => node.status === 'claimed',
      ).length,
      ownAdsLabeled: labeledAds,
    },
  };
}

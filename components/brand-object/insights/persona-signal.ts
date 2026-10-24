/**
 * Pure display helpers for Chapter 06's awareness ladder — no React, no IO, so
 * the label derivation is unit-testable on its own.
 *
 * Persona pains/desires are stored as whole sentences ("Needs gluten-free
 * options that fit everyday eating."). The ladder shows them as chips, which
 * need a short head-phrase; the full sentence stays reachable on hover/tap and
 * on the chip's accessible name, so shortening never destroys information.
 */
import { AWARENESS_STAGES, type AwarenessStage } from '@/lib/brand-object/types';

/**
 * Sentence openers the synthesis prompt produces. Longest-first so
 * "may also need" wins over "needs" — the array is sorted at module load, not
 * by hand, so entries can be appended in any order.
 */
const LEAD_INS = [
  'actively avoids',
  'is looking for',
  'may also need',
  'worries about',
  'struggles with',
  'worries that',
  'looks for',
  'hopes to',
  'wants to',
  'needs to',
  'believes',
  'requires',
  'expects',
  'prefers',
  'avoids',
  'values',
  'wants',
  'needs',
  'seeks',
  'feels',
  'fears',
  'hopes',
].sort((a, b) => b.length - a.length);

/**
 * Clause boundaries — everything after the first one is qualification, which
 * the hover detail carries.
 */
const CLAUSE_MARKERS = [
  ' that ',
  ' without ',
  ' because ',
  ' so that ',
  ' in order to ',
  ' while ',
  ' when ',
  ' but ',
  ' and ',
  ' to ',
  ' for ',
];

/**
 * A clause cut is only worth taking when the head still says something. Cutting
 * "products that accommodate gluten-free diets" at " that " leaves "products",
 * which is noise — below this length the cut is abandoned and the label falls
 * through to plain truncation.
 */
const MIN_HEAD_CHARS = 12;
/** Chip width ceiling before an ellipsis; tuned to two chips per mobile row. */
const MAX_LABEL_CHARS = 38;

/**
 * Derive the short chip label for one pain/desire sentence. Deterministic and
 * lossy by design — always render the full text somewhere reachable.
 */
export function shortenSignal(text: string): string {
  const full = text.replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
  if (!full) return '';

  let head = full;

  // 1. Drop the lead-in verb ("Needs …", "Actively avoids …").
  const lower = head.toLowerCase();
  for (const lead of LEAD_INS) {
    if (lower.startsWith(`${lead} `)) {
      head = head.slice(lead.length + 1);
      break;
    }
  }

  // 2. Drop a leading article left behind by the verb strip ("the product is…").
  head = head.replace(/^(the|a|an) /i, '');

  // 3. Cut at the earliest clause boundary that leaves a substantive head.
  const cutAt = CLAUSE_MARKERS.map((marker) => head.toLowerCase().indexOf(marker))
    .filter((index) => index >= MIN_HEAD_CHARS)
    .sort((a, b) => a - b)[0];
  if (cutAt !== undefined) head = head.slice(0, cutAt);

  head = head.trim().replace(/[,;:]+$/, '');

  // 4. Hard ceiling, broken on a word boundary.
  if (head.length > MAX_LABEL_CHARS) {
    const clipped = head.slice(0, MAX_LABEL_CHARS);
    const lastSpace = clipped.lastIndexOf(' ');
    head = `${(lastSpace > MIN_HEAD_CHARS ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
  }

  return head || full;
}

/** True when the full sentence carries detail the chip label dropped. */
export function signalHasDetail(text: string): boolean {
  const full = text.replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
  return full.toLowerCase() !== shortenSignal(text).toLowerCase();
}

export interface AwarenessStageMeta {
  /** Rung heading. */
  label: string;
  /** One line on what the stage means, so the ladder reads without a legend. */
  blurb: string;
  /** Rung heading + quote-mark color. */
  text: string;
  /** Timeline node border. */
  node: string;
  /** Timeline segment running from this node to the next. */
  rail: string;
}

/**
 * The Schwartz spectrum as a cold-to-warm ramp ending in the accent (slate, sky,
 * the chart violet, then magenta at rising strength). It deliberately avoids rose and
 * emerald, which are already spoken for by pain/desire signals inside the
 * cards — stage color and signal color must never be confusable.
 */
export const AWARENESS_STAGE_META: Record<AwarenessStage, AwarenessStageMeta> = {
  unaware: {
    label: 'Unaware',
    blurb: "Doesn't yet know they have the problem",
    text: 'text-slate-500 dark:text-slate-400',
    node: 'border-slate-400 dark:border-slate-500',
    rail: 'bg-slate-300/70 dark:bg-slate-600/50',
  },
  problem_aware: {
    label: 'Problem aware',
    blurb: "Feels the pain, hasn't found a fix",
    text: 'text-sky-600 dark:text-sky-400',
    node: 'border-sky-500 dark:border-sky-400',
    rail: 'bg-sky-400/60 dark:bg-sky-500/40',
  },
  solution_aware: {
    label: 'Solution aware',
    blurb: 'Shopping the category, not yet the brand',
    text: 'text-chart-2',
    node: 'border-chart-2',
    rail: 'bg-chart-2/50',
  },
  product_aware: {
    label: 'Product aware',
    blurb: "Knows the brand, weighing whether it's worth it",
    text: 'text-brand-text/80',
    node: 'border-brand/60',
    rail: 'bg-brand/30',
  },
  most_aware: {
    label: 'Most aware',
    blurb: 'Convinced, needs a reason to buy now',
    text: 'text-brand-text',
    node: 'border-brand',
    rail: 'bg-brand/60',
  },
};

/**
 * What an ad has to DO at each stage — the actionable half of the framework,
 * shown in the "Five Stages of Customer Awareness" explainer. Kept beside the
 * stage meta so stage semantics live in one module, but separate from it
 * because only real stages have a job: the unstaged rung is a data gap, not a
 * place a buyer can stand.
 */
export const AWARENESS_STAGE_JOB: Record<AwarenessStage, string> = {
  unaware:
    'Name the problem before you name the product. Nothing about your brand lands until the cost of the status quo does.',
  problem_aware:
    'Show that a fix exists and that it looks like your category. You are selling the solution shape, not the label on it.',
  solution_aware:
    'Say what makes your version different: the mechanism, not the promise. Everyone in the category is already promising the outcome.',
  product_aware:
    'Close the gap between wanting it and buying it: proof, comparisons, guarantees, the price framed against what it replaces.',
  most_aware:
    'Just make the offer. A deadline, a bundle, a restock: anything that beats "later".',
};

/** Rung for personas whose stage the synthesis never resolved. */
export const UNSTAGED_META: AwarenessStageMeta = {
  label: 'Stage not classified',
  blurb: 'Synthesis did not resolve an awareness stage',
  text: 'text-muted-foreground',
  node: 'border-muted-foreground/50',
  rail: 'bg-muted-foreground/25',
};

const STAGE_SET = new Set<string>(AWARENESS_STAGES);

export function isAwarenessStage(value: string | null): value is AwarenessStage {
  return value !== null && STAGE_SET.has(value);
}

/**
 * The four stages a real buyer can be OBSERVED in. `unaware` is dropped: by
 * definition it holds someone who doesn't yet know they have the problem, so
 * customer voice can never contain one — the chapter's only unaware card is a
 * labeled backward projection (`extrapolated`). The headline is a claim about
 * where observed buyers cluster, so it reasons over these four alone; the
 * projection still renders on the ladder below, just never in the arithmetic.
 */
export const OBSERVABLE_AWARENESS_STAGES = AWARENESS_STAGES.filter(
  (stage) => stage !== 'unaware',
);
const OBSERVABLE_STAGE_SET = new Set<string>(OBSERVABLE_AWARENESS_STAGES);

function isObservableStage(value: string | null): value is AwarenessStage {
  return value !== null && OBSERVABLE_STAGE_SET.has(value);
}

/** Where the personas actually sit on the spectrum — chapter 06's headline. */
export interface AwarenessSpread {
  /** Personas whose stage resolved. */
  staged: number;
  /** Personas the synthesis left unstaged — counted, never quietly dropped. */
  unstaged: number;
  /** Heaviest rung. Ties break COLD: the colder stage is the more expensive
   * audience to talk to, so it is the one worth leading the chapter with. */
  modal: AwarenessStage;
  modalCount: number;
  /** Coldest and warmest occupied rungs — the span the brand actually covers. */
  coldest: AwarenessStage;
  warmest: AwarenessStage;
  /** Observable stages nobody landed on, in spectrum order. */
  empty: AwarenessStage[];
}

/**
 * Count the personas onto the spectrum. Returns null when not one OBSERVED
 * persona has a resolved stage — there is no shape to state, and the ladder's
 * projected/unstaged rungs already say so.
 *
 * The unaware projection is excluded up front: it is an extrapolation, not a
 * buyer we observed, so it can neither be where buyers "cluster" nor an empty
 * rung the brand has failed to reach.
 */
export function awarenessSpread(
  personas: Array<{ awarenessStage: string | null; extrapolated: boolean }>,
): AwarenessSpread | null {
  const counts = new Map<AwarenessStage, number>();
  let unstaged = 0;
  for (const persona of personas) {
    if (persona.extrapolated) continue;
    if (isObservableStage(persona.awarenessStage)) {
      counts.set(
        persona.awarenessStage,
        (counts.get(persona.awarenessStage) ?? 0) + 1,
      );
    } else {
      unstaged += 1;
    }
  }

  // Spectrum order throughout, so "first occupied" is literally the coldest and
  // the modal tie-break falls to the colder stage for free.
  const occupied = OBSERVABLE_AWARENESS_STAGES.filter((stage) => counts.has(stage));
  if (occupied.length === 0) return null;

  let modal = occupied[0];
  for (const stage of occupied) {
    if ((counts.get(stage) ?? 0) > (counts.get(modal) ?? 0)) modal = stage;
  }

  return {
    staged: occupied.reduce((sum, stage) => sum + (counts.get(stage) ?? 0), 0),
    unstaged,
    modal,
    modalCount: counts.get(modal) ?? 0,
    coldest: occupied[0],
    warmest: occupied[occupied.length - 1],
    empty: OBSERVABLE_AWARENESS_STAGES.filter((stage) => !counts.has(stage)),
  };
}

/**
 * The trailing, muted half of the headline: which rungs are empty and how many
 * personas never resolved to one. Both are findings — an empty rung is an
 * audience the evidence has not reached, not a rendering gap.
 */
export function awarenessGapNote(spread: AwarenessSpread): string {
  const parts: string[] = [];
  const occupied = OBSERVABLE_AWARENESS_STAGES.length - spread.empty.length;

  if (spread.empty.length === 0) {
    parts.push('Every observable stage has someone on it.');
  } else if (spread.empty.length <= 2) {
    parts.push(
      `Nobody yet at ${spread.empty
        .map((stage) => AWARENESS_STAGE_META[stage].label.toLowerCase())
        .join(' or ')}.`,
    );
  } else {
    parts.push(
      `Only ${occupied} of the four observable stages ${occupied === 1 ? 'has' : 'have'} anyone on ${occupied === 1 ? 'it' : 'them'}.`,
    );
  }

  if (spread.unstaged > 0) {
    parts.push(
      `${spread.unstaged} persona${spread.unstaged === 1 ? '' : 's'} never resolved to a stage.`,
    );
  }

  return parts.join(' ');
}

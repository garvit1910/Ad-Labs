/**
 * Strategy selector (2026-08) — turns competitor-analysis evidence
 * (market_prior brand facts distilled from winning competitor ads) + the
 * org's own realized-performance priors into the brief's strategic inputs:
 * ONE angle per run (the pack/genome invariant), a set of producible
 * {hook_archetype × format} treatment GROUPS the candidates fan out across,
 * and alternate angles worth a separate brief.
 *
 * PURE — no IO. Signals arrive pre-fetched (strategy-sources.ts reads the
 * market_prior facts; the route maps its already-gated performance priors
 * via signalsFromPerformancePriors).
 *
 * ATTRIBUTION INVARIANT: `angleDirective` is the string that becomes
 * `genome.angle` / `pack.meta.spec.angle`. Explicit angles and own-genome
 * prior angles pass VERBATIM; taxonomy values map through the fixed
 * deterministicAngleDirective template — stable per value, so concept
 * attribution accumulates. A raw label enum token never reaches the
 * composer.
 *
 * MODE (2026-08-18): `mode: 'iterate'` (the default, and the shape every
 * pre-feature caller submits) exploits ranked evidence exactly as before.
 * `mode: 'experiment'` explores a caller-picked untested opportunity: the
 * angle comes from `experimentSelection.angleKey` through the SAME
 * deterministic template (attribution key preserved), and an
 * `open_territory` format is promoted to the primary group when producible.
 * Everything else — hooks, alternates, evidence, execution cues — is
 * untouched.
 */
import type {
  AdFormat,
  HookArchetype,
  VisualStyle,
} from '@/services/ad-library/label-taxonomy';
import type { PerformancePriors } from '@/lib/creative-engine/loop/types';
import {
  composeExecutionDirective,
  formatExcludesPeople,
} from './execution-directives';
import type {
  ExperimentSelection,
  GenerationMode,
} from './experiment-types';
import {
  FORMAT_PRODUCIBILITY,
  HOOK_PRODUCIBILITY,
  type HookRequirement,
} from './producibility';

export type StrategySignalSource =
  | 'own_genome'
  | 'own_label'
  | 'market_prior'
  | 'industry_benchmark'
  /** Sampled-alternate provenance: the org's own belief arms (label+genome cells, Workstream E). */
  | 'own_belief'
  /** Cross-tenant pooled label cells — the cold-start prior fallback (Workstream E Part 2). */
  | 'pooled_label';

export interface StrategySignal {
  dimension:
    | 'angle'
    | 'hook_archetype'
    | 'format'
    | 'offer_type'
    | 'persona'
    | 'style'
    | 'setting'
    | 'tone'
    | 'people_present'
    | 'aspect_ratio';
  value: string;
  /** Normalized within its source (market share/100, prior weight 1, …). */
  weight: number;
  source: StrategySignalSource;
  evidence?: {
    share?: number;
    conceptCount?: number;
    roas?: number | null;
    /** Sanitized winning-ad staging notes (market_prior format/style facts). */
    note?: string;
  };
}

/** One per-candidate treatment: a producible hook × format pairing. */
export interface StrategyGroup {
  key: string;
  hookArchetype: HookArchetype;
  /** Copywriter execution directive (rides the brand-copy wrapper). */
  hookDirective: string;
  format: AdFormat;
  /**
   * Image-variation scene directive (rides the per-candidate variation):
   * the FORMAT's scene (shot type) then the HOOK's scene (the moment it
   * depicts), space-joined — either alone when the other is empty. One
   * composed string, NOT two fields: `extractStrategyStamp` is a whitelist.
   */
  sceneDirective: string;
  visualStyle: VisualStyle;
  /**
   * Market execution cues (2026-08) — how winning ads in this market are
   * staged, composed from the execution-dim priors. PER GROUP (2026-09-22):
   * the market's top values filtered to the cues THIS group's format can
   * honour (`FORMAT_CUE_EXCLUSIONS`), so two groups can carry different
   * directives; appended AFTER sceneDirective in the variation text. Absent
   * when no execution evidence exists or every cue was filtered out.
   */
  executionDirective?: string;
  /**
   * Sanitized staging notes lifted from a winning ad's vision labels
   * (PR2 — execution_notes → market fact evidence quote). Absent until
   * notes-bearing priors exist.
   */
  executionNotes?: string;
}

export interface SelectedStrategy {
  /** Structured angle key ('explicit' | 'own_prior' | a taxonomy value). */
  angleKey: string;
  /** THE genome/pack angle string (see attribution invariant above). */
  angleDirective: string;
  groups: StrategyGroup[];
  /** Alternate producible angles worth composing a separate brief for. */
  alternates: Array<{
    angleKey: string;
    angleDirective: string;
    weight: number;
    source: StrategySignalSource;
  }>;
  /** Bounded evidence trail — stamped into tags.strategy for lineage. */
  evidence: StrategySignal[];
  /** 'evidence' = competitor/own data drove the pick; 'goal_blueprint' = none existed. */
  fallbackTier: 'evidence' | 'goal_blueprint';
  /**
   * Provenance SIBLING of `fallbackTier` (experiment mode, 2026-08-18).
   * Present ONLY when a caller-supplied experiment selection produced the
   * angle; absent on every iterate-mode result, so default-path
   * `SelectedStrategy` objects stay byte-identical to pre-feature runs.
   *
   * `fallbackTier` deliberately stays `'evidence'` on the experiment path:
   * it answers "did we get a real angle, or fall back to the goal
   * blueprint", and BOTH `composeBrief`'s angle ladder and
   * `resolveSpecAngleTheme`'s fail-closed gate key on that meaning. Widening
   * that union would silently drop the experiment angle out of the composed
   * brief. Read `selectionTier` (or the brief's `tags.strategy.mode`) to tell
   * an experiment pick from a ranked-evidence pick.
   */
  selectionTier?: 'experiment_selection';
}

export interface StrategyPackHints {
  hasNumericFact: boolean;
  hasSocialProofFact: boolean;
  hasCustomerVerbatim: boolean;
  hasOfferFact: boolean;
}

const SOURCE_TIER_WEIGHT: Record<StrategySignalSource, number> = {
  own_genome: 3,
  own_belief: 2.5,
  own_label: 2,
  market_prior: 1.5,
  industry_benchmark: 1,
  // Pooled cross-tenant evidence ranks with the industry tier: borrowed, not earned.
  pooled_label: 1,
};

export const MAX_GROUPS_DEFAULT = 4;
export const MAX_ALTERNATES = 3;
const MAX_EVIDENCE = 12;

/** No-evidence default treatments — producible, product-grounded. */
const DEFAULT_HOOKS: HookArchetype[] = [
  'problem_callout',
  'bold_claim',
  'pov_relatable',
  'question',
];
const DEFAULT_FORMATS: AdFormat[] = [
  'lifestyle_static',
  'product_only_static',
  'studio',
];

function humanizeValue(value: string): string {
  return value.replaceAll('_', ' ').replaceAll('-', ' ').trim();
}

/**
 * Fixed template mapping a taxonomy angle value to the genome angle string.
 * DETERMINISTIC and stable per value — this string is the attribution key.
 */
export function deterministicAngleDirective(value: string): string {
  return `Lead with the ${humanizeValue(value)} angle proven by winning ads in this market`;
}

/**
 * Map the org's (already multi-brand-gated) genome priors onto signals.
 *
 * `source` defaults to 'own_genome' (every pre-E caller, byte-identical). The
 * cold-start fallback passes 'pooled_label' so its ENUM tokens take the angle
 * branch's deterministic-template path instead of the own_genome VERBATIM path
 * — a raw label enum token must never reach the composer (angle-verbatim
 * invariant, lib/creative-engine/CLAUDE.md §Workstream D deferral).
 */
export function signalsFromPerformancePriors(
  priors: PerformancePriors | undefined,
  source: StrategySignalSource = 'own_genome'
): StrategySignal[] {
  if (!priors) return [];
  const signals: StrategySignal[] = [];
  if (priors.topAngle?.value) {
    signals.push({
      dimension: 'angle',
      value: priors.topAngle.value,
      weight: 1,
      source,
      evidence: { roas: priors.topAngle.roas },
    });
  }
  if (priors.topHookArchetype?.value) {
    signals.push({
      dimension: 'hook_archetype',
      value: priors.topHookArchetype.value,
      weight: 1,
      source,
      evidence: { roas: priors.topHookArchetype.roas },
    });
  }
  return signals;
}

function requirementMet(
  requirement: HookRequirement | undefined,
  hints: StrategyPackHints
): boolean {
  if (!requirement) return true;
  switch (requirement) {
    case 'numeric_fact':
      return hints.hasNumericFact;
    case 'social_proof_fact':
      return hints.hasSocialProofFact;
    case 'customer_verbatim':
      return hints.hasCustomerVerbatim;
    case 'offer_fact':
      return hints.hasOfferFact;
  }
}

/**
 * Every hook the engine can produce AND whose fact requirement this pack meets
 * — the sampler's `allowedValues` restriction (Workstream E).
 */
export function producibleHookAllowlist(packHints: StrategyPackHints): HookArchetype[] {
  return (Object.keys(HOOK_PRODUCIBILITY) as HookArchetype[]).filter((hook) => {
    const entry = HOOK_PRODUCIBILITY[hook];
    return entry.status !== 'not_producible' && requirementMet(entry.requires, packHints);
  });
}

/** Every format the engine can produce — the sampler's `allowedValues` (Workstream E). */
export function producibleFormatAllowlist(): AdFormat[] {
  return (Object.keys(FORMAT_PRODUCIBILITY) as AdFormat[]).filter(
    (format) => FORMAT_PRODUCIBILITY[format].status !== 'not_producible'
  );
}

/** Score signals per dimension: Σ (source tier × normalized weight), ranked. */
function rankDimension(
  signals: StrategySignal[],
  dimension: StrategySignal['dimension']
): Array<{ value: string; score: number }> {
  const scores = new Map<string, number>();
  for (const signal of signals) {
    if (signal.dimension !== dimension) continue;
    const score =
      SOURCE_TIER_WEIGHT[signal.source] * Math.max(0, Math.min(1, signal.weight));
    scores.set(signal.value, (scores.get(signal.value) ?? 0) + score);
  }
  return [...scores.entries()]
    .map(([value, score]) => ({ value, score }))
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
}

const EXECUTION_NOTES_PROMPT_CAP = 280;

/** Word-boundary cap so a long stored note never truncates mid-word. */
function capExecutionNotes(note: string): string {
  if (note.length <= EXECUTION_NOTES_PROMPT_CAP) return note;
  const cut = note.slice(0, EXECUTION_NOTES_PROMPT_CAP);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Format scene first (it sets the shot type), hook scene second (it sets the
 * moment the shot captures) — without the hook half, every hook on the same
 * format rendered the same picture (prod brief 007520cf: four groups, four
 * "person eating cereal at a kitchen table"). Either alone when the other is
 * empty, so `selectStrategyGroups`' non-empty predicate is unchanged.
 */
function composeSceneDirective(formatScene: string, hookScene: string): string {
  return [formatScene, hookScene].filter((part) => part.length > 0).join(' ');
}

function buildGroup(hook: HookArchetype, format: AdFormat): StrategyGroup {
  const hookEntry = HOOK_PRODUCIBILITY[hook];
  const formatEntry = FORMAT_PRODUCIBILITY[format];
  // A people-free format gets the hook's still-life variant when it has one,
  // or a person-centric moment would override the format's shot (the same
  // clash the execution-cue filter removes).
  const hookScene =
    (formatExcludesPeople(format) ? hookEntry.stillLifeSceneDirective : undefined) ??
    hookEntry.sceneDirective ??
    '';
  return {
    key: `${hook}__${format}`,
    hookArchetype: hook,
    hookDirective: hookEntry.hookDirective ?? '',
    format,
    sceneDirective: composeSceneDirective(
      formatEntry.sceneDirective ?? '',
      hookScene,
    ),
    visualStyle: formatEntry.visualStyle ?? 'polished_studio',
  };
}

/**
 * The greedy hooks ladder: evidence-ranked producible hooks, topped up from
 * the defaults so a run always has treatment variety. Extracted verbatim from
 * `selectStrategy` so the sampled path (Workstream E) can reuse it for
 * per-dimension fallback and slot top-up; `cap` bounds only the top-up (the
 * ranked list itself may exceed it — the group loop slices).
 */
export function rankedProducibleHooks(
  signals: StrategySignal[],
  packHints: StrategyPackHints,
  cap: number
): HookArchetype[] {
  const hookRanked = rankDimension(signals, 'hook_archetype')
    .map((entry) => entry.value)
    .filter((value): value is HookArchetype => value in HOOK_PRODUCIBILITY)
    .filter((hook) => {
      const entry = HOOK_PRODUCIBILITY[hook];
      return (
        entry.status !== 'not_producible' &&
        requirementMet(entry.requires, packHints)
      );
    });
  const hooks: HookArchetype[] = [...hookRanked];
  for (const fallbackHook of DEFAULT_HOOKS) {
    if (hooks.length >= cap) break;
    if (!hooks.includes(fallbackHook)) hooks.push(fallbackHook);
  }
  return hooks;
}

/** The greedy formats ladder — same shape as the hooks ladder, no fact gate. */
export function rankedProducibleFormats(
  signals: StrategySignal[],
  cap: number
): AdFormat[] {
  const formatRanked = rankDimension(signals, 'format')
    .map((entry) => entry.value)
    .filter((value): value is AdFormat => value in FORMAT_PRODUCIBILITY)
    .filter((format) => FORMAT_PRODUCIBILITY[format].status !== 'not_producible');
  const formats: AdFormat[] = [...formatRanked];
  for (const fallbackFormat of DEFAULT_FORMATS) {
    if (formats.length >= cap) break;
    if (!formats.includes(fallbackFormat)) formats.push(fallbackFormat);
  }
  return formats;
}

/**
 * The greedy group-assembly tail, extracted verbatim: buildGroup pairing
 * (hooks drive, formats round-robin) + per-group, format-filtered market
 * execution cues + winning-ad staging notes. Shared by the greedy and
 * sampled (Workstream E) paths so every group is directive-equipped
 * identically regardless of who picked the hook/format values.
 */
export function buildStrategyGroups(
  signals: StrategySignal[],
  hooks: HookArchetype[],
  formats: AdFormat[],
  maxGroups: number
): StrategyGroup[] {
  const groups: StrategyGroup[] = [];
  for (let i = 0; i < maxGroups && i < hooks.length; i += 1) {
    groups.push(buildGroup(hooks[i], formats[i % formats.length]));
  }

  // ── Market execution cues: the top value of each execution dim maps
  // through the fixed cue vocabulary, filtered PER GROUP to the cues its
  // format's scene can honour (a product-only hero must never be told to
  // "include a real person"). Deterministic per (signals, format), so the
  // stamp stays resume-safe; no surviving cue → the field stays absent, and
  // no execution evidence at all is byte-identical to pre-feature runs.
  const topOf = (dimension: StrategySignal['dimension']): string | undefined =>
    rankDimension(signals, dimension)[0]?.value;
  const topExecution = {
    style: topOf('style'),
    setting: topOf('setting'),
    tone: topOf('tone'),
    peoplePresent: topOf('people_present'),
  };
  for (const group of groups) {
    const executionDirective = composeExecutionDirective(topExecution, group.format);
    if (executionDirective) group.executionDirective = executionDirective;
  }

  // ── Winning-ad staging notes: prefer the note attached to THIS group's
  // format prior (the closest "how they run that ad" evidence), else the
  // top style prior's note. Sanitized upstream (market distillation);
  // re-capped here so the prompt budget holds whatever upstream stored.
  const noteFor = (
    dimension: StrategySignal['dimension'],
    value: string | undefined,
  ): string | undefined =>
    value === undefined
      ? undefined
      : signals.find(
          (signal) =>
            signal.dimension === dimension &&
            signal.value === value &&
            typeof signal.evidence?.note === 'string' &&
            signal.evidence.note.length > 0,
        )?.evidence?.note;
  const styleNote = noteFor('style', topOf('style'));
  for (const group of groups) {
    const note = noteFor('format', group.format) ?? styleNote;
    if (note) group.executionNotes = capExecutionNotes(note);
  }

  return groups;
}

export interface SelectStrategyInput {
  signals: StrategySignal[];
  goal: string;
  platform: string;
  /** User-supplied competitive angle — ALWAYS wins, passed verbatim. */
  explicitAngle?: string;
  packHints: StrategyPackHints;
  maxGroups?: number;
  /**
   * Iterate (default) exploits ranked evidence exactly as before; experiment
   * explores a caller-picked untested opportunity. Omitted/'iterate' is
   * byte-identical to pre-feature selection.
   */
  mode?: GenerationMode;
  /**
   * The opportunity the caller picked (validated upstream: `angleKey` is a
   * known taxonomy angle). Only consulted when `mode === 'experiment'`.
   */
  experimentSelection?: ExperimentSelection;
}

/**
 * ANGLE PRECEDENCE (documented so the caller-bug case is not a surprise):
 *   explicitAngle > experiment selection > ranked evidence > goal blueprint.
 *
 * An `explicitAngle` arriving together with `mode: 'experiment'` is a caller
 * bug (the composer never sends both). The explicit angle wins and the
 * experiment path is suppressed ENTIRELY — angle, format preference and
 * `selectionTier` — so the result is byte-identical to today's explicit-angle
 * run rather than a half-applied hybrid.
 *
 * This is DEFENSE IN DEPTH only: the briefs route rejects that combination
 * outright (422 `EXPERIMENT_ANGLE_CONFLICT`) so no brief can ever stamp
 * `mode: 'experiment'` for a run the selection did not drive. Keep both — the
 * selector is also called by the strategy preview route and by tests.
 */
export function selectStrategy(input: SelectStrategyInput): SelectedStrategy {
  const maxGroups = Math.max(1, input.maxGroups ?? MAX_GROUPS_DEFAULT);

  // ── Angle: explicit → own-genome prior (verbatim prose) → top taxonomy
  // evidence (via the deterministic template) → goal blueprint.
  const angleRanked = rankDimension(input.signals, 'angle');
  const bySourceValue = new Map(
    input.signals
      .filter((signal) => signal.dimension === 'angle')
      .map((signal) => [signal.value, signal.source] as const)
  );
  let angleKey: string;
  let angleDirective: string;
  let fallbackTier: SelectedStrategy['fallbackTier'] = 'evidence';
  let selectionTier: SelectedStrategy['selectionTier'];
  const explicit = input.explicitAngle?.trim();
  // Experiment mode is suppressed by an explicit angle (see the precedence
  // note on selectStrategy) and by a blank/absent selection.
  const experimentAngleKey =
    !explicit && input.mode === 'experiment'
      ? input.experimentSelection?.angleKey.trim() || undefined
      : undefined;
  if (explicit) {
    angleKey = 'explicit';
    angleDirective = explicit;
  } else if (experimentAngleKey) {
    // The SAME deterministic renderer the evidence tier uses, so the taxonomy
    // value survives verbatim as the attribution key and
    // `pack.meta.spec.angle === genome.angle` holds with zero pipeline change.
    angleKey = experimentAngleKey;
    angleDirective = deterministicAngleDirective(experimentAngleKey);
    selectionTier = 'experiment_selection';
  } else if (angleRanked.length > 0) {
    const top = angleRanked[0];
    const source = bySourceValue.get(top.value);
    if (source === 'own_genome') {
      // Own-genome angle values are already prose — attribution key verbatim.
      angleKey = 'own_prior';
      angleDirective = top.value;
    } else {
      angleKey = top.value;
      angleDirective = deterministicAngleDirective(top.value);
    }
  } else {
    angleKey = 'goal_blueprint';
    angleDirective = '';
    fallbackTier = 'goal_blueprint';
  }

  // ── Hooks: ranked evidence filtered by producibility + fact availability,
  // topped up with defaults so a run always has treatment variety.
  const hooks = rankedProducibleHooks(input.signals, input.packHints, maxGroups);

  // ── Formats: same producibility ladder, defaults as top-up.
  let formats: AdFormat[] = rankedProducibleFormats(input.signals, maxGroups);

  // ── Experiment format targeting: an `open_territory` opportunity names the
  // empty angle × format cell to fill, so that format must lead (groups[0]
  // takes formats[0]). Producibility still governs — an unproducible cell
  // (video/on-image-text/carousel) falls straight through to the unchanged
  // ranked ladder rather than aping a format the engine cannot execute.
  const experimentFormat = experimentAngleKey
    ? input.experimentSelection?.format
    : undefined;
  if (
    experimentFormat &&
    experimentFormat in FORMAT_PRODUCIBILITY &&
    FORMAT_PRODUCIBILITY[experimentFormat as AdFormat].status !== 'not_producible'
  ) {
    const preferred = experimentFormat as AdFormat;
    formats = [preferred, ...formats.filter((format) => format !== preferred)];
  }

  // ── Groups + market execution cues + staging notes (shared assembly tail).
  const groups = buildStrategyGroups(input.signals, hooks, formats, maxGroups);

  // ── Alternates: the next producible-evidence angles (a separate brief per
  // angle — one angle per run is the pack invariant).
  const alternates = angleRanked
    .slice(explicit ? 0 : 1)
    .filter((entry) => entry.value !== angleKey)
    .slice(0, MAX_ALTERNATES)
    .map((entry) => {
      const source = bySourceValue.get(entry.value) ?? 'market_prior';
      return {
        angleKey: entry.value,
        angleDirective:
          source === 'own_genome'
            ? entry.value
            : deterministicAngleDirective(entry.value),
        weight: Math.round(entry.score * 100) / 100,
        source,
      };
    });

  return {
    angleKey,
    angleDirective,
    groups,
    alternates,
    evidence: input.signals.slice(0, MAX_EVIDENCE),
    fallbackTier,
    // Conditional spread — absent (not undefined) on the iterate path, so the
    // returned object and its stamped JSON are byte-identical to pre-feature.
    ...(selectionTier ? { selectionTier } : {}),
  };
}

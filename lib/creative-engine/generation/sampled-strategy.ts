/**
 * Sampled strategy selection (Workstream E) — the Thompson overlay on the
 * greedy selector. PURE: no IO, no clock, no `Math.random`.
 *
 * v1 samples exactly THREE dimensions — `angle_universal`, `hook_archetype`,
 * `format` — the ones with complete chosen → brief → genome → rollup plumbing.
 * Persona and style stay greedy-derived (persona has no strategy field or
 * directive seam; style is derived from the format entry in `buildGroup`);
 * both deferrals are recorded verbatim inside every `SamplerRecord` so the
 * scope cut is visible in the data, not just in docs.
 *
 * Arms are built ONLY through `armsFromBeliefs` (drops `'other'`
 * unconditionally, tolerates `beliefs: null`, max-ESS dedupe) and restricted
 * to the producible allowlists — a sampled pick can never name a hook/format
 * the engine cannot execute.
 *
 * THE RNG CONTRACT (replay): one derived stream PER STAGE —
 *   angle stage   `makeRng(seed)`     — the angle thompson pick, then the
 *                                       alternates (same dimension, same stream)
 *   hook stage    `makeRng(seed + 1)` — hook thompson ×k, then widest (no rng)
 *   format stage  `makeRng(seed + 2)` — format thompson ×k, then widest (no rng)
 * Stage isolation is the point: a skipped angle (explicitAngle), an arm
 * appearing in one dimension at the nightly sweep, or an exhausted arm set
 * NEVER shifts another stage's draws — so an explicit-angle run's hook draws
 * equal a sampled-angle run's hook draws under the same seed, and shadow
 * diffs stay stable per dimension. Within a stage, picks consume the stream
 * in strict order (one `sampleBeta` per arm in code-unit arm order, per D's
 * contract); `sampleBeta` is rejection-based, so each draw consumes a
 * VARIABLE number of uniforms — an ORDER contract, not a fixed-count one.
 * Determinism holds at the function level: identical `(base, rows, seed)` ⇒
 * byte-identical `SampledStrategyOutcome`, forever.
 *
 * Thin data is NEVER an error: every dimension degrades independently to
 * today's greedy ranking with a recorded `fallback` reason. This function is
 * total — throwing is reserved for programmer errors, which the route's
 * fail-soft catch also covers.
 */

import type { AdFormat, HookArchetype } from '@/services/ad-library/label-taxonomy';
import { ANGLES } from '@/services/ad-library/label-taxonomy';
import {
  armsFromBeliefs,
  makeRng,
  thompsonPick,
  widestCurvePick,
  type Arm,
  type ArmsFromBeliefsRow,
  type BeliefLayer,
  type SamplerDecision,
} from '@/lib/creative-engine/loop/sampler';
import { DEFAULT_CREATIVE_OBJECTIVE } from '@/lib/creative-engine/loop/objective';
import type { CreativeObjective } from '@/lib/creative-engine/loop/types';
import { FORMAT_PRODUCIBILITY, HOOK_PRODUCIBILITY } from './producibility';
import {
  MAX_ALTERNATES,
  MAX_GROUPS_DEFAULT,
  buildStrategyGroups,
  deterministicAngleDirective,
  producibleFormatAllowlist,
  producibleHookAllowlist,
  rankedProducibleFormats,
  rankedProducibleHooks,
  selectStrategy,
  type SelectedStrategy,
  type SelectStrategyInput,
} from './strategy';

export const SAMPLER_VERSION = 1;

/**
 * v1 samples the CLICK layer for all three dimensions: it accrues evidence
 * fastest (leaves the prior regime soonest), creative dimensions act mostly
 * upstream of the click, and Workstream D's pool floors are click-ESS-tuned
 * (CLICK_PRIOR_ESS=500). The purchase layer stays the audit/calibration
 * layer; `layer` is recorded on every decision and in the stamp so a later
 * flip is data-visible, never silent.
 */
export const SAMPLER_LAYER: BeliefLayer = 'click';

/**
 * WHAT the sampler optimizes (step 6 — the objective layer). Resolved by the
 * caller from `organizations.settings.creativeFence.objective` and passed in,
 * so this module stays pure and env-free. Absent = `ctr`, and the whole file
 * then runs its pre-objective path verbatim: same arms, same draws, same
 * record. `cpc` is an ALIAS of `ctr` (see `loop/objective.ts`) — it stamps, it
 * does not re-rank.
 */
export interface SampledStrategyOptions {
  objective?: CreativeObjective;
}

/**
 * Thompson slots per multi-slot dimension. The remaining slot goes to
 * `widestCurvePick` — 3 + 1 over MAX_GROUPS_DEFAULT (4) is the ~25% explore
 * floor: a guaranteed curiosity slot even in weeks when every raffle lands on
 * favorites.
 */
export const THOMPSON_SLOTS = 3;

export type SamplerDimension = 'angle_universal' | 'hook_archetype' | 'format';

export type DimensionFallbackReason =
  | 'explicit_angle'
  | 'experiment_mode'
  | 'no_arms'
  | 'insufficient_arms';

export interface SampledDimensionRecord {
  /** In rng-consumption order: thompson picks first, then the widest explore pick (draw-less). */
  decisions: SamplerDecision[];
  /** Final slot values after greedy top-up — what actually fills the strategy. */
  picks: string[];
  /** Present when any slot fell back to greedy ranking; greedySlots = how many. */
  fallback?: { reason: DimensionFallbackReason; greedySlots: number };
}

export interface SamplerRecord {
  version: typeof SAMPLER_VERSION;
  seed: number;
  layer: BeliefLayer;
  dimensions: {
    angle_universal: SampledDimensionRecord;
    hook_archetype: SampledDimensionRecord;
    format: SampledDimensionRecord;
  };
  /** Subsequent without-replacement thompson picks over the remaining angle arms (≤ MAX_ALTERNATES). */
  alternates: SamplerDecision[];
  /** The two locked v1 scope deferrals, recorded verbatim in every stamp. */
  deferred: {
    persona: 'no_strategy_seam';
    style: 'derived_from_format';
  };
  /**
   * The ruler the org chose. ABSENT under the default `ctr`, so every stamp
   * recorded before the objective layer still compares byte-for-byte; present
   * for `cpc` too, whose ranking is `ctr`'s but whose CHOICE is auditable.
   * Per-decision fallbacks live on each `SamplerDecision`.
   */
  objective?: CreativeObjective;
}

export interface SampledStrategyOutcome {
  /** Exactly `selectStrategy(base)` — the shadow/off flyer and the per-dimension fallback source. */
  greedy: SelectedStrategy;
  /** The live-mode flyer. */
  sampled: SelectedStrategy;
  record: SamplerRecord;
}

/**
 * Sequential thompson picks WITHOUT replacement (arm removed between draws)
 * followed by one deliberate widest-curve explore pick over the remainder.
 * Decisions are returned in rng-consumption order.
 */
function pickSlots(
  arms: Arm[],
  slotTarget: number,
  rng: () => number,
  objective: CreativeObjective
): SamplerDecision[] {
  const decisions: SamplerDecision[] = [];
  let remaining = arms;
  const thompsonTarget = Math.min(THOMPSON_SLOTS, slotTarget);
  while (decisions.length < thompsonTarget && remaining.length > 0) {
    const decision = thompsonPick(remaining, SAMPLER_LAYER, rng, objective);
    if (!decision) break;
    decisions.push(decision);
    remaining = remaining.filter((arm) => arm.value !== decision.picked.value);
  }
  if (decisions.length < slotTarget && remaining.length > 0) {
    const explore = widestCurvePick(remaining, SAMPLER_LAYER, objective);
    if (explore) decisions.push(explore);
  }
  return decisions;
}

/** Append greedy-ranked values (minus already-picked) until the target or exhaustion. */
function topUp<T extends string>(
  picks: T[],
  ranked: T[],
  target: number
): { values: T[]; greedySlots: number } {
  const values = [...picks];
  let greedySlots = 0;
  for (const candidate of ranked) {
    if (values.length >= target) break;
    if (values.includes(candidate)) continue;
    values.push(candidate);
    greedySlots += 1;
  }
  return { values, greedySlots };
}

export function selectSampledStrategy(
  base: SelectStrategyInput,
  rows: ArmsFromBeliefsRow[],
  seed: number,
  options: SampledStrategyOptions = {}
): SampledStrategyOutcome {
  const objective = options.objective ?? DEFAULT_CREATIVE_OBJECTIVE;
  // Spread LAST and only off-default, so a default-objective record keeps its
  // exact pre-objective key order and every recorded stamp still compares.
  const objectiveStamp =
    objective === DEFAULT_CREATIVE_OBJECTIVE ? {} : { objective };
  const greedy = selectStrategy(base);

  // ── Experiment mode: the sampler DEFERS entirely. Experiment briefs are the
  // HUMAN explore lane — the caller-picked opportunity must drive the angle
  // and lead format (selectStrategy already honored it inside `greedy`), and a
  // sampled override would fight the deliberate choice. Zero rng consumed; the
  // routes gate this upstream too — this is defense in depth, same posture as
  // selectStrategy's own explicit-angle suppression of experiment picks.
  if (base.mode === 'experiment') {
    const deferred = (): SampledDimensionRecord => ({
      decisions: [],
      picks: [],
      fallback: { reason: 'experiment_mode', greedySlots: 0 },
    });
    return {
      greedy,
      sampled: greedy,
      record: {
        version: SAMPLER_VERSION,
        seed,
        layer: SAMPLER_LAYER,
        dimensions: {
          angle_universal: deferred(),
          hook_archetype: deferred(),
          format: deferred(),
        },
        alternates: [],
        deferred: {
          persona: 'no_strategy_seam',
          style: 'derived_from_format',
        },
        ...objectiveStamp,
      },
    };
  }
  const maxGroups = Math.max(1, base.maxGroups ?? MAX_GROUPS_DEFAULT);
  // Per-stage derived streams — see the rng contract in the module docblock.
  const angleRng = makeRng(seed);
  const hookRng = makeRng(seed + 1);
  const formatRng = makeRng(seed + 2);

  const angleArms = armsFromBeliefs(rows, 'angle_universal', {
    allowedValues: ANGLES,
  });
  const hookArms = armsFromBeliefs(rows, 'hook_archetype', {
    allowedValues: producibleHookAllowlist(base.packHints),
  });
  const formatArms = armsFromBeliefs(rows, 'format', {
    allowedValues: producibleFormatAllowlist(),
  });

  // ── 1. Angle: ONE per run (the pack invariant). An explicit angle ALWAYS
  // wins and consumes zero rng, so hook/format draws are seed-stable across
  // explicit and sampled runs.
  const explicit = base.explicitAngle?.trim();
  let angleRecord: SampledDimensionRecord;
  let sampledAngleToken: string | null = null;
  let remainingAngleArms: Arm[] = [];
  if (explicit) {
    angleRecord = {
      decisions: [],
      picks: [greedy.angleKey],
      fallback: { reason: 'explicit_angle', greedySlots: 1 },
    };
  } else if (angleArms.length === 0) {
    angleRecord = {
      decisions: [],
      picks: [greedy.angleKey],
      fallback: { reason: 'no_arms', greedySlots: 1 },
    };
  } else {
    const decision = thompsonPick(
      angleArms,
      SAMPLER_LAYER,
      angleRng,
      objective
    ) as SamplerDecision;
    sampledAngleToken = decision.picked.value;
    remainingAngleArms = angleArms.filter((arm) => arm.value !== sampledAngleToken);
    angleRecord = { decisions: [decision], picks: [sampledAngleToken] };
  }

  // ── 2+3. Hooks: 3 thompson + 1 widest, greedy top-up for missing slots.
  const greedyHooks = rankedProducibleHooks(base.signals, base.packHints, maxGroups);
  let hooks: HookArchetype[];
  let hookRecord: SampledDimensionRecord;
  if (hookArms.length === 0) {
    // Full greedy list (not sliced): the group loop slices, and byte-equality
    // with the greedy groups requires the identical hooks array.
    hooks = greedyHooks;
    hookRecord = {
      decisions: [],
      picks: greedyHooks.slice(0, maxGroups),
      fallback: { reason: 'no_arms', greedySlots: Math.min(maxGroups, greedyHooks.length) },
    };
  } else {
    const decisions = pickSlots(hookArms, maxGroups, hookRng, objective);
    const sampledPicks = decisions
      .map((decision) => decision.picked.value)
      .filter((value): value is HookArchetype => value in HOOK_PRODUCIBILITY);
    const { values, greedySlots } = topUp(sampledPicks, greedyHooks, maxGroups);
    hooks = values;
    hookRecord = {
      decisions,
      picks: values,
      ...(greedySlots > 0
        ? { fallback: { reason: 'insufficient_arms' as const, greedySlots } }
        : {}),
    };
  }

  // ── 4+5. Formats: a sampled SET round-robined through the shared assembly
  // (hooks[i] × formats[i % len]) — no hook×format interaction cell exists in
  // performance_memory, so per-group pairing would fabricate structure the
  // data cannot support.
  const greedyFormats = rankedProducibleFormats(base.signals, maxGroups);
  let formats: AdFormat[];
  let formatRecord: SampledDimensionRecord;
  if (formatArms.length === 0) {
    formats = greedyFormats;
    formatRecord = {
      decisions: [],
      picks: greedyFormats.slice(0, maxGroups),
      fallback: {
        reason: 'no_arms',
        greedySlots: Math.min(maxGroups, greedyFormats.length),
      },
    };
  } else {
    const decisions = pickSlots(formatArms, maxGroups, formatRng, objective);
    const sampledPicks = decisions
      .map((decision) => decision.picked.value)
      .filter((value): value is AdFormat => value in FORMAT_PRODUCIBILITY);
    const { values, greedySlots } = topUp(sampledPicks, greedyFormats, maxGroups);
    formats = values;
    formatRecord = {
      decisions,
      picks: values,
      ...(greedySlots > 0
        ? { fallback: { reason: 'insufficient_arms' as const, greedySlots } }
        : {}),
    };
  }

  // ── 6. Alternates: only when the angle itself was sampled — further
  // without-replacement raffles over the remaining angle arms.
  const alternateDecisions: SamplerDecision[] = [];
  let alternates = greedy.alternates;
  if (sampledAngleToken !== null && remainingAngleArms.length > 0) {
    let remaining = remainingAngleArms;
    while (alternateDecisions.length < MAX_ALTERNATES && remaining.length > 0) {
      const decision = thompsonPick(remaining, SAMPLER_LAYER, angleRng, objective);
      if (!decision) break;
      alternateDecisions.push(decision);
      remaining = remaining.filter((arm) => arm.value !== decision.picked.value);
    }
    alternates = alternateDecisions.map((decision) => {
      const token = decision.picked.value;
      const mean =
        decision.arms.find((arm) => arm.value === token)?.mean ?? 0;
      return {
        angleKey: token,
        angleDirective: deterministicAngleDirective(token),
        weight: Math.round(mean * 100) / 100,
        source: 'own_belief' as const,
      };
    });
  }

  const sampled: SelectedStrategy = {
    angleKey: sampledAngleToken ?? greedy.angleKey,
    angleDirective:
      sampledAngleToken !== null
        ? deterministicAngleDirective(sampledAngleToken)
        : greedy.angleDirective,
    groups: buildStrategyGroups(base.signals, hooks, formats, maxGroups),
    alternates,
    evidence: greedy.evidence,
    fallbackTier: sampledAngleToken !== null ? 'evidence' : greedy.fallbackTier,
  };

  return {
    greedy,
    sampled,
    record: {
      version: SAMPLER_VERSION,
      seed,
      layer: SAMPLER_LAYER,
      dimensions: {
        angle_universal: angleRecord,
        hook_archetype: hookRecord,
        format: formatRecord,
      },
      alternates: alternateDecisions,
      deferred: {
        persona: 'no_strategy_seam',
        style: 'derived_from_format',
      },
      ...objectiveStamp,
    },
  };
}

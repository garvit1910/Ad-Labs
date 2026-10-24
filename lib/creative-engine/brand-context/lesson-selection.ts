/**
 * Which derived lessons may ground THIS run (Workstream H). PURE.
 *
 * The rule, and the whole reason conditioning is safe: a lesson enters a pack
 * only when it is about an ingredient the run ALREADY CHOSE. So a pack can
 * reinforce the strategy ("this angle has been your strongest — lean in") but
 * can never contradict it. That matters because Workstream E's bandit
 * deliberately explores: it will pick a hook the lessons do not favour, and a
 * generically-ranked lesson would then sit in the prompt arguing against the
 * hook directive the same brief just issued.
 *
 * Selection happens here rather than inside `compile.ts` because the compiler
 * is a pure function of (spec, rows) and must not learn the strategy vocabulary
 * — the same division that puts `resolveSpecAngleTheme` in the briefs route.
 * The chosen lessons ride `spec.lessonRefs`, resolved exactly like
 * `keyMessageRef`.
 */
import { LESSON_DIMENSIONS, parseLessonFactKey, type LessonDimension } from './lessons';
import type { StoredBrandContextRow } from './types';

/** What the run picked, per dimension. Absent/null = nothing to match against. */
export interface LessonRunSelection {
  angleUniversal?: string | null;
  hookArchetype?: string | null;
  format?: string | null;
}

/** The per-group shape `runSelectionFromStrategy` reads. Structural on purpose. */
export interface LessonStrategyGroup {
  hookArchetype: string;
  format: string;
}

/**
 * What a run may be said to have "chosen", given its strategy plan.
 *
 * The angle is run-wide by construction (ONE angle per run — see
 * `generation/strategy.ts`), so an angle lesson is always safe. Hook and format
 * are PER GROUP, and a brief compiles exactly ONE pack that every group's copy
 * call renders. So a hook lesson naming group 0's hook would also land in group
 * 1's prompt, arguing for a hook that group is not executing — the precise
 * contradiction this whole design exists to prevent. A hook or format therefore
 * counts as "chosen" only when EVERY group agrees on it.
 */
export function runSelectionFromStrategy(input: {
  angleUniversal?: string | null;
  groups?: readonly LessonStrategyGroup[] | null;
}): LessonRunSelection {
  const groups = input.groups ?? [];
  const uniform = <K extends keyof LessonStrategyGroup>(key: K): string | null => {
    if (groups.length === 0) return null;
    const first = groups[0][key];
    return groups.every((group) => group[key] === first) ? first : null;
  };
  return {
    angleUniversal: input.angleUniversal ?? null,
    hookArchetype: uniform('hookArchetype'),
    format: uniform('format'),
  };
}

export interface LessonMatch {
  rowId: string;
  ref: string;
  dimension: LessonDimension;
  dimensionValue: string;
  relation: 'top_performing' | 'creative_fatigue';
}

export interface LessonSelectionResult {
  /** Row refs for `spec.lessonRefs`, ranked, already capped by the caller's budget. */
  refs: string[];
  /** Every match, ranked — what shadow mode records as "would have used". */
  matched: LessonMatch[];
  /**
   * Why nothing matched, when nothing did. `experiment_mode` is stamped by the
   * briefs route, never returned here: lessons feed ONLY the iteration arm, so
   * an experiment brief skips selection entirely (product rule, 2026-09-21).
   */
  skipped?: 'no_lesson_rows' | 'no_chosen_dimensions' | 'no_match' | 'experiment_mode';
}

/**
 * Fatigue first. A warning that the chosen territory is wearing out changes
 * what the creative should do; a "this works" reinforcement mostly confirms it.
 * If only one lesson can travel, the actionable one travels.
 */
const RELATION_RANK: Record<LessonMatch['relation'], number> = {
  creative_fatigue: 0,
  top_performing: 1,
};

const DIMENSION_RANK = new Map<LessonDimension, number>(
  LESSON_DIMENSIONS.map((dimension, index) => [dimension, index]),
);

function chosenValueFor(
  dimension: LessonDimension,
  selection: LessonRunSelection,
): string | null {
  switch (dimension) {
    case 'angle_universal':
      return selection.angleUniversal ?? null;
    case 'hook_archetype':
      return selection.hookArchetype ?? null;
    case 'format':
      return selection.format ?? null;
  }
}

/**
 * Rank the lesson rows that match what this run chose.
 *
 * Ordering is fully deterministic and locale-independent: relation rank →
 * dimension rank (`LESSON_DIMENSIONS` order) → priority desc → rowId asc by
 * code unit. Refs are pinned (`rowId@vN`) so the pack records the exact version
 * that grounded the run, and a later ingest cannot retroactively change what a
 * past brief was told.
 */
export function selectLessonRefs(
  rows: StoredBrandContextRow[],
  selection: LessonRunSelection,
  limit: number,
): LessonSelectionResult {
  const lessonRows = rows.filter(
    (row) => (row.sourceRef as { section?: unknown } | null)?.section === 'performance_prior',
  );
  if (lessonRows.length === 0) return { refs: [], matched: [], skipped: 'no_lesson_rows' };

  const anyChosen = LESSON_DIMENSIONS.some(
    (dimension) => (chosenValueFor(dimension, selection) ?? '').length > 0,
  );
  if (!anyChosen) return { refs: [], matched: [], skipped: 'no_chosen_dimensions' };

  const ranked: Array<{ match: LessonMatch; priority: number }> = [];
  for (const row of lessonRows) {
    const factKey = (row.sourceRef as { factKey?: unknown } | null)?.factKey;
    if (typeof factKey !== 'string') continue;
    const identity = parseLessonFactKey(factKey);
    if (!identity) continue;
    if (chosenValueFor(identity.dimension, selection) !== identity.dimensionValue) continue;
    ranked.push({
      priority: row.priority,
      match: {
        rowId: row.rowId,
        ref: `${row.rowId}@v${row.version}`,
        dimension: identity.dimension,
        dimensionValue: identity.dimensionValue,
        relation: identity.relation,
      },
    });
  }

  if (ranked.length === 0) return { refs: [], matched: [], skipped: 'no_match' };

  ranked.sort(
    (a, b) =>
      RELATION_RANK[a.match.relation] - RELATION_RANK[b.match.relation] ||
      (DIMENSION_RANK.get(a.match.dimension) ?? 99) -
        (DIMENSION_RANK.get(b.match.dimension) ?? 99) ||
      b.priority - a.priority ||
      (a.match.rowId < b.match.rowId ? -1 : a.match.rowId > b.match.rowId ? 1 : 0),
  );

  const matched = ranked.map((entry) => entry.match);
  return { refs: matched.slice(0, Math.max(0, limit)).map((match) => match.ref), matched };
}

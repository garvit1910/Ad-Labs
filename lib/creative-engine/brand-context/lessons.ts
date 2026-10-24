/**
 * Derived performance LESSONS as brand-context rows (Workstream H). PURE.
 *
 * The engine writes what it learned into `brand_facts`
 * (section `performance_prior`, Workstream A). This module is the one place
 * that decides what a lesson SAYS when it reaches the ad factory, and the
 * shape it travels in.
 *
 * ── Two hard rules, both learned the hard way ────────────────────────────────
 *
 * 1. THE PACK-FACING STATEMENT IS NUMBER-FREE. The copy renderer prints every
 *    fact under `## Brand facts`, and the copy system prompt tells the model to
 *    "Ground every claim ONLY in the brand facts provided… use the number
 *    EXACTLY as the fact states it". `findUngroundedNumerals`
 *    (generation/brand-copy.ts) then treats any digit in the pack-rendered text
 *    as groundable — i.e. LEGAL TO PRINT IN A LIVE AD. A lesson's raw statement
 *    ("3.20x platform ROAS over 4100.00 spend") reaching a pack would therefore
 *    licence an ad that quotes the brand's own ROAS at a customer. So the
 *    lesson row carries a DIRECTIVE authored here, and the numeric statement
 *    stays on the brand_fact for the report card and the audit trail. The
 *    digit-free property is asserted by test, and enforced defensively below.
 *
 * 2. LESSONS ARE NOT ORDINARY BRAND FACTS. `mapBrandFactsToRows` still excludes
 *    `performance_prior` (`NON_CONTEXT_SECTIONS`) and its two locking tests are
 *    untouched: a derived lesson must never fall through the open-strings
 *    default into the general fact pool. It becomes a row only through this
 *    deliberately-shaped family, selected by explicit ref, into its own
 *    reserved slot.
 *
 * v1 admits exactly the three dimensions Workstream E samples — the ones where
 * a lesson can be matched to what the run actually chose. Persona, style and
 * aspect_ratio lessons stay out (same scope cut, same reason as E's "three
 * dimensions, not five"), which also keeps every legal dimension value
 * digit-free by construction.
 */

/** The `brand_facts` section derived lessons live in (loop/fact-mapping.ts). */
export const LESSON_SECTION = 'performance_prior';

/**
 * The `content.section` a lesson row carries — and therefore the label the copy
 * renderer prints: `[own performance] …`. Deliberately NOT the raw
 * `performance_prior`: `content.section` is data the renderer interpolates, so
 * a readable label costs nothing and needs no template edit (which would force
 * a `RENDERER_VERSIONS.copy` bump). True provenance rides `sourceRef.section`.
 */
export const LESSON_CONTENT_SECTION = 'own performance';

/** Row-id namespace. Distinct from `fact_*` so lessons are greppable and cannot collide. */
export const LESSON_ROW_ID_PREFIX = 'lesson_';

/**
 * The dimensions a lesson may be written about, in the order a tie is broken.
 * Exactly Workstream E's three sampled dimensions: a lesson the engine cannot
 * match against what the run chose has no business grounding that run's copy.
 */
export const LESSON_DIMENSIONS = ['angle_universal', 'hook_archetype', 'format'] as const;
export type LessonDimension = (typeof LESSON_DIMENSIONS)[number];

const LESSON_DIMENSION_SET: ReadonlySet<string> = new Set(LESSON_DIMENSIONS);

/**
 * `'other'` is legal for ACCOUNTING and must never be a pickable arm — the same
 * rule `armsFromBeliefs` (loop/sampler.ts) enforces unconditionally for the
 * bandit. Fenced here, at parse time, so no `other` lesson row is ever ingested
 * in the first place: "Ads built on the other angle have been your strongest
 * performers" is nonsense a brand should never read.
 */
const UNPICKABLE_LESSON_VALUE = 'other';

/** How each dimension reads in a sentence. */
const DIMENSION_NOUN: Record<LessonDimension, string> = {
  angle_universal: 'angle',
  hook_archetype: 'hook',
  format: 'format',
};

/** The two claims a lesson can make (loop/fact-candidates.ts emits exactly these). */
export type LessonRelation = 'top_performing' | 'creative_fatigue';

export interface LessonIdentity {
  platform: string;
  rollupSource: string;
  dimension: LessonDimension;
  dimensionValue: string;
  relation: LessonRelation;
}

export function isLessonRowId(rowId: string): boolean {
  return rowId.startsWith(LESSON_ROW_ID_PREFIX);
}

/**
 * Parse `perf:<platform>:<rollupSource>:<dimension>:<value>:<relation>`
 * (`performanceFactKey`, loop/fact-mapping.ts). Returns null for anything that
 * is not a v1-admissible lesson — a foreign key shape, a dimension outside
 * `LESSON_DIMENSIONS`, or a relation we have no sentence for.
 *
 * The value is joined back from the middle rather than taken as one segment:
 * `performance_memory` values are open text at the DB and one of them
 * (aspect_ratio's `9:16`) genuinely contains the separator. Parsing from both
 * ends is correct even though v1's admitted dimensions never hit that case.
 */
export function parseLessonFactKey(factKey: string): LessonIdentity | null {
  const parts = factKey.split(':');
  if (parts.length < 6 || parts[0] !== 'perf') return null;

  const [, platform, rollupSource, dimension] = parts;
  const relationRaw = parts[parts.length - 1];
  const dimensionValue = parts.slice(4, parts.length - 1).join(':');
  if (!platform || !rollupSource || !dimensionValue) return null;
  if (dimensionValue === UNPICKABLE_LESSON_VALUE) return null;
  if (!LESSON_DIMENSION_SET.has(dimension)) return null;

  const relation: LessonRelation | null =
    relationRaw === 'creative_fatigue'
      ? 'creative_fatigue'
      : relationRaw === `top_performing_${dimension}`
        ? 'top_performing'
        : null;
  if (!relation) return null;

  return {
    platform,
    rollupSource,
    dimension: dimension as LessonDimension,
    dimensionValue,
    relation,
  };
}

/** `problem_callout` → `problem callout`. Display only; never an attribution key. */
export function humanizeLessonValue(value: string): string {
  return value.replace(/_+/g, ' ').trim();
}

/**
 * The number-free directive a lesson row carries into a pack.
 *
 * Returns null when the sentence would contain a digit. Today no admitted
 * dimension has a digit-bearing value, so this never fires — it exists so that
 * WIDENING `LESSON_DIMENSIONS` later cannot silently smuggle a numeral into the
 * copy prompt's grounding surface. Fail closed: no lesson beats a leaked number.
 */
export function lessonDirective(identity: LessonIdentity): string | null {
  const noun = DIMENSION_NOUN[identity.dimension];
  const value = humanizeLessonValue(identity.dimensionValue);
  const statement =
    identity.relation === 'creative_fatigue'
      ? `The ${value} ${noun} is showing fatigue for this brand — find a fresh expression of it rather than repeating recent executions.`
      : `Ads built on the ${value} ${noun} have been this brand's strongest performers — lean into that territory with confidence.`;
  return /\d/.test(statement) ? null : statement;
}

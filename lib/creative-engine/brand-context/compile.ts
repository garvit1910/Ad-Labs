/**
 * The pure, deterministic pack compiler.
 *
 * No IO, no LLM, no clock, no randomness, no reliance on input row order:
 * selection = tag filter → priority desc with rowId asc tie-break →
 * per-slot budget caps. All per-run variation lives in the CompileSpec,
 * chosen upstream. Literal key order in assembled objects is irrelevant —
 * canonicalization sorts keys before hashing.
 */
import {
  ASSETS_SLOT_BUDGET,
  BrandContextError,
  COMPILER_VERSION,
  FACTS_SLOT_BUDGET,
  LESSONS_SLOT_BUDGET,
  RENDERER_VERSIONS,
  RULES_SLOT_BUDGET,
  VOICE_SLOT_BUDGET,
  type BrandContextPack,
  type BrandContextRow,
  type CompileResult,
  type CompileSpec,
  type RowRef,
  type SlotEntry,
  type TagFilters,
} from './types';
import { fingerprintPack } from './fingerprint';
import { isLessonRowId } from './lessons';

const ROW_REF_RE = /^(.+?)@v(\d+)$/;

/** `row_x@vN` → pinned; bare `row_x` → latest among the input rows. */
export function parseRowRef(ref: string): {
  rowId: string;
  version: number | null;
} {
  const match = ROW_REF_RE.exec(ref);
  if (match) return { rowId: match[1], version: Number(match[2]) };
  return { rowId: ref, version: null };
}

/** Back-compat alias — persona refs share the generic row-ref shape. */
export const parsePersonaRef = parseRowRef;

/** Code-unit string comparison — deterministic, locale-independent. */
function compareRowIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function intersects(rowList: string[], specList: string[]): boolean {
  return rowList.some((value) => specList.includes(value));
}

/**
 * A row applies iff, for EACH axis, its list is absent/empty (= applies
 * everywhere) or intersects the spec's values. Corollary: with no
 * spec.product, product-tagged rows are excluded — they are product-specific
 * and no product is targeted.
 *
 * `themes` is INTENTIONALLY absent from this enumeration: it is a
 * ranking-only axis (see selectFacts). Filtering on it would exclude every
 * themed fact from a run whose angle theme differs — the opposite of what
 * relevance-aware selection is for.
 */
export function rowMatchesSpec(
  tagFilters: TagFilters,
  specTags: Required<TagFilters>,
): boolean {
  const axes: Array<[string[] | undefined, string[]]> = [
    [tagFilters.channels, specTags.channels],
    [tagFilters.products, specTags.products],
    [tagFilters.audiences, specTags.audiences],
    [tagFilters.stages, specTags.stages],
  ];
  return axes.every(
    ([rowList, specList]) =>
      !rowList || rowList.length === 0 || intersects(rowList, specList),
  );
}

function validateSpec(spec: CompileSpec): void {
  const nonEmpty: Array<[string, unknown]> = [
    ['platform', spec.platform],
    ['aspectRatio', spec.aspectRatio],
    ['goal', spec.goal],
    ['personaRef', spec.personaRef],
    ['angle', spec.angle],
  ];
  for (const [field, value] of nonEmpty) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BrandContextError(
        'VALIDATION',
        `Compile spec field "${field}" must be a non-empty string`,
        'Provide the full task spec (platform, aspectRatio, goal, personaRef, angle, candidates)',
        400,
      );
    }
  }
  if (!Number.isInteger(spec.candidates) || spec.candidates < 1) {
    throw new BrandContextError(
      'VALIDATION',
      'Compile spec field "candidates" must be a positive integer',
      'Provide candidates >= 1',
      400,
    );
  }
  if (
    spec.keyMessageRef !== undefined &&
    (typeof spec.keyMessageRef !== 'string' || spec.keyMessageRef.length === 0)
  ) {
    throw new BrandContextError(
      'VALIDATION',
      'Compile spec field "keyMessageRef" must be a non-empty string when present',
      'Provide a fact row ref like fact_usp_x@v2, or omit the field',
      400,
    );
  }
  if (
    spec.angleTheme !== undefined &&
    (typeof spec.angleTheme !== 'string' || spec.angleTheme.length === 0)
  ) {
    throw new BrandContextError(
      'VALIDATION',
      'Compile spec field "angleTheme" must be a non-empty string when present',
      'Provide a taxonomy angle value like natural_ingredients, or omit the field',
      400,
    );
  }
  if (spec.lessonRefs !== undefined) {
    const refs = spec.lessonRefs;
    const valid =
      Array.isArray(refs) &&
      refs.length > 0 &&
      refs.length <= LESSONS_SLOT_BUDGET &&
      refs.every((ref) => typeof ref === 'string' && ref.length > 0) &&
      new Set(refs).size === refs.length;
    if (!valid) {
      throw new BrandContextError(
        'VALIDATION',
        `Compile spec field "lessonRefs" must be 1-${LESSONS_SLOT_BUDGET} unique non-empty row refs when present`,
        'Provide lesson row refs like lesson_perf_meta_label_format_ugc@v1, or omit the field',
        400,
      );
    }
  }
  if (spec.overrides !== undefined) {
    const audience = spec.overrides.audience;
    const hasAudience = typeof audience === 'string' && audience.length > 0;
    // One canonical representation: an overrides object with nothing in it
    // must never reach the fingerprint.
    if (!hasAudience) {
      throw new BrandContextError(
        'VALIDATION',
        'Compile spec "overrides" must carry at least one non-empty override',
        'Provide overrides.audience, or omit the overrides object',
        400,
      );
    }
  }
}

export interface RowRefErrorCodes {
  unknown: string;
  wrongType: string;
  label: string;
}

export const PERSONA_REF_CODES: RowRefErrorCodes = {
  unknown: 'UNKNOWN_PERSONA_REF',
  wrongType: 'PERSONA_REF_NOT_PERSONA',
  label: 'personaRef',
};

export const KEY_MESSAGE_REF_CODES: RowRefErrorCodes = {
  unknown: 'UNKNOWN_KEY_MESSAGE_REF',
  wrongType: 'KEY_MESSAGE_REF_NOT_FACT',
  label: 'keyMessageRef',
};

export const LESSON_REF_CODES: RowRefErrorCodes = {
  unknown: 'UNKNOWN_LESSON_REF',
  wrongType: 'LESSON_REF_NOT_FACT',
  label: 'lessonRefs',
};

/**
 * One resolution algorithm for every spec row ref (persona, key message):
 * pinned `@vN` must exist in the input rows; a bare ref takes the max
 * version present. Exported so the briefs route derives text from exactly
 * the row the compiler will select.
 */
export function resolveRowRef(
  ref: string,
  rows: BrandContextRow[],
  expected: BrandContextRow['rowType'],
  codes: RowRefErrorCodes,
): BrandContextRow {
  const parsed = parseRowRef(ref);
  let resolved: BrandContextRow | undefined;
  if (parsed.version !== null) {
    resolved = rows.find(
      (row) => row.rowId === parsed.rowId && row.version === parsed.version,
    );
  } else {
    for (const row of rows) {
      if (row.rowId !== parsed.rowId) continue;
      if (!resolved || row.version > resolved.version) resolved = row;
    }
  }
  if (!resolved) {
    throw new BrandContextError(
      codes.unknown,
      `${codes.label} "${ref}" does not resolve to a store row`,
      `Run brand-context ingest, or check the ${codes.label} id/version against the rows listing`,
      404,
    );
  }
  if (resolved.rowType !== expected) {
    throw new BrandContextError(
      codes.wrongType,
      `${codes.label} "${ref}" resolves to a ${resolved.rowType} row`,
      `Point ${codes.label} at a ${expected}-type row`,
      400,
    );
  }
  return resolved;
}

function resolvePersona(
  spec: CompileSpec,
  rows: BrandContextRow[],
): BrandContextRow {
  return resolveRowRef(spec.personaRef, rows, 'persona', PERSONA_REF_CODES);
}

function selectSlot(
  rows: BrandContextRow[],
  rowType: BrandContextRow['rowType'],
  specTags: Required<TagFilters>,
  budget: number,
): BrandContextRow[] {
  const survivors = rows
    .filter(
      (row) => row.rowType === rowType && rowMatchesSpec(row.tagFilters, specTags),
    )
    .sort(
      (a, b) => b.priority - a.priority || compareRowIds(a.rowId, b.rowId),
    );
  return Number.isFinite(budget) ? survivors.slice(0, budget) : survivors;
}

/**
 * Whether a row carries the run's angle theme. Ranking input only — a row
 * with no themes, or a spec with no angleTheme, is simply untiered.
 */
function matchesAngleTheme(row: BrandContextRow, angleTheme?: string): boolean {
  if (!angleTheme) return false;
  const themes = row.tagFilters.themes;
  return Array.isArray(themes) && themes.includes(angleTheme);
}

/**
 * Facts slot with optional pinned key message: the pinned fact BYPASSES the
 * tag filter (an explicit human pick outranks the deterministic heuristic),
 * rides FIRST, is deduped by rowId against the tag-selected survivors, and
 * counts against FACTS_SLOT_BUDGET.
 *
 * Survivors order by (theme match desc, priority desc, rowId asc) — the
 * theme is a RANKING TIER, never a filter: an off-theme fact is still fully
 * selectable, it just sorts below the on-theme ones. With no
 * `spec.angleTheme` the first key is constant and the order is byte-for-byte
 * the pre-v3 priority order.
 */
function selectFacts(
  spec: CompileSpec,
  rows: BrandContextRow[],
  specTags: Required<TagFilters>,
): BrandContextRow[] {
  const pinned = spec.keyMessageRef
    ? resolveRowRef(spec.keyMessageRef, rows, 'fact', KEY_MESSAGE_REF_CODES)
    : null;
  const survivors = rows
    .filter(
      (row) =>
        row.rowType === 'fact' &&
        // A lesson is a `fact` row so it needs no new row type and no renderer
        // change — but it enters ONLY through `spec.lessonRefs`, never by
        // competing here. Keyed on the row-id namespace rather than on the
        // resolved set, because the dangerous case is the UNREFERENCED lesson:
        // a shadow-mode org has lesson rows in its store and passes no refs, and
        // without this every one of its packs would quietly carry a strategy
        // directive in a brand-fact slot. (Caught by the route matrix test, not
        // by inspection.)
        !isLessonRowId(row.rowId) &&
        rowMatchesSpec(row.tagFilters, specTags) &&
        (!pinned || row.rowId !== pinned.rowId),
    )
    .sort(
      (a, b) =>
        Number(matchesAngleTheme(b, spec.angleTheme)) -
          Number(matchesAngleTheme(a, spec.angleTheme)) ||
        b.priority - a.priority ||
        compareRowIds(a.rowId, b.rowId),
    );
  const ordered = pinned ? [pinned, ...survivors] : survivors;
  return ordered.slice(0, FACTS_SLOT_BUDGET);
}

/**
 * Resolve `spec.lessonRefs` in the order the caller gave them (it already
 * ranked them), deduped by rowId, capped at the reserved budget. Validation has
 * already bounded the array, so the cap is belt-and-braces.
 */
function selectLessons(spec: CompileSpec, rows: BrandContextRow[]): BrandContextRow[] {
  if (!spec.lessonRefs || spec.lessonRefs.length === 0) return [];
  const resolved: BrandContextRow[] = [];
  const seen = new Set<string>();
  for (const ref of spec.lessonRefs) {
    const row = resolveRowRef(ref, rows, 'fact', LESSON_REF_CODES);
    if (seen.has(row.rowId)) continue;
    seen.add(row.rowId);
    resolved.push(row);
  }
  return resolved.slice(0, LESSONS_SLOT_BUDGET);
}

function toSlotEntry(row: BrandContextRow): SlotEntry {
  return { id: row.rowId, version: row.version, content: row.content };
}

/**
 * `rows` is normally the latest live store snapshot; pinned personaRef
 * versions must be present in the input to resolve (the service passes
 * latest-live only, so a pinned historical persona resolves only while it
 * is still the latest).
 */
export function compile(
  spec: CompileSpec,
  rows: BrandContextRow[],
  opts: { brandProfileId: string },
): CompileResult {
  validateSpec(spec);

  if (rows.length === 0) {
    throw new BrandContextError(
      'EMPTY_STORE',
      'The brand context store has no rows for this profile',
      'Run brand-context ingest first',
      422,
    );
  }

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.rowId}@v${row.version}`;
    if (seen.has(key)) {
      throw new BrandContextError(
        'DUPLICATE_ROW',
        `Compiler input contains "${key}" twice`,
        'Pass each (rowId, version) at most once',
        500,
      );
    }
    seen.add(key);
  }

  const persona = resolvePersona(spec, rows);
  const personaStage = persona.content.awarenessStage;
  const specTags: Required<TagFilters> = {
    channels: [spec.platform],
    products: spec.product ? [spec.product] : [],
    audiences: [persona.rowId],
    stages: typeof personaStage === 'string' ? [personaStage] : [],
    // Ranking-only axis — never part of rowMatchesSpec's enumeration.
    themes: [],
  };

  const lessons = selectLessons(spec, rows);
  const facts = selectFacts(spec, rows, specTags);
  const voice = selectSlot(rows, 'voice', specTags, VOICE_SLOT_BUDGET);
  const rules = selectSlot(rows, 'rule', specTags, RULES_SLOT_BUDGET);
  const assets = selectSlot(rows, 'asset', specTags, ASSETS_SLOT_BUDGET);

  // Counts BRAND facts only, deliberately. A lesson is a strategy directive,
  // not grounding material: a pack carrying one lesson and no brand fact cannot
  // ground copy any better than an empty one, and it would put that directive
  // at `facts[0]`, which the image renderer reads as the key claim to visualize.
  if (facts.length === 0) {
    throw new BrandContextError(
      'EMPTY_PACK',
      'No fact rows survive the tag filter — a pack with zero facts cannot ground copy',
      'Broaden the spec (platform/product/persona) or ingest more brand facts',
      422,
    );
  }

  const selected = [...facts, ...lessons, ...voice, ...rules, ...assets, persona];
  const rowRefs: RowRef[] = selected
    .map((row) => ({ id: row.rowId, version: row.version }))
    .sort((a, b) => compareRowIds(a.id, b.id));

  const pack: BrandContextPack = {
    meta: {
      compilerVersion: COMPILER_VERSION,
      rendererVersions: { ...RENDERER_VERSIONS },
      brandProfileId: opts.brandProfileId,
      spec: {
        platform: spec.platform,
        aspectRatio: spec.aspectRatio,
        goal: spec.goal,
        personaRef: spec.personaRef,
        angle: spec.angle,
        candidates: spec.candidates,
        ...(spec.product ? { product: spec.product } : {}),
        ...(spec.keyMessageRef ? { keyMessageRef: spec.keyMessageRef } : {}),
        // Absent when the run has no strategy-derived theme — the field must
        // not enter the hashed bytes then (same rule as `product`).
        ...(spec.angleTheme ? { angleTheme: spec.angleTheme } : {}),
        // Absent unless lessons actually flew — an `off`/`shadow` run compiles
        // byte-identically to a pre-Workstream-H one.
        ...(spec.lessonRefs && lessons.length > 0
          ? { lessonRefs: [...spec.lessonRefs] }
          : {}),
        // Overrides affect only the spec echo — the fingerprint must move
        // when the override text changes, but slots are unchanged.
        ...(spec.overrides?.audience
          ? { overrides: { audience: spec.overrides.audience } }
          : {}),
      },
      rowRefs,
    },
    slots: {
      // Lessons LAST. See LESSONS_SLOT_BUDGET: `facts[0]` is the image
      // renderer's key claim, and the key-message marker is index-0 keyed.
      facts: [...facts, ...lessons].map(toSlotEntry),
      voice: voice.map(toSlotEntry),
      rules: rules.map(toSlotEntry),
      assets: assets.map(toSlotEntry),
      persona: toSlotEntry(persona),
    },
  };

  return { pack, fingerprint: fingerprintPack(pack) };
}

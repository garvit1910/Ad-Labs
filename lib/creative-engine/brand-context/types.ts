/**
 * Brand context layer — domain types and constants.
 *
 * The store (`brand_context_rows`) is versioned and append-only: a
 * (rowId, version) pair is immutable once written; edits insert version+1.
 * The compiler (`compile.ts`) is pure and deterministic — all per-run
 * variation lives in the `CompileSpec`, chosen upstream. Packs are the
 * fixed-shape IR consumed by the copy/image/judge renderers (Phase 4);
 * their sha256-over-canonical-JSON fingerprint is the dedupe key and the
 * lineage join key every generated creative will carry.
 */

export const BRAND_CONTEXT_ROW_TYPES = [
  'fact',
  'voice',
  'rule',
  'asset',
  'persona',
] as const;
export type BrandContextRowType = (typeof BRAND_CONTEXT_ROW_TYPES)[number];

/**
 * Selection tags. Absent/empty axis = the row applies everywhere on that
 * axis. Only non-empty arrays are ever stored (one canonical representation
 * keeps content hashes stable).
 *
 * `themes` is the odd one out: it is a RANKING-ONLY axis (deterministic
 * angle themes derived at ingest, `themes.ts`). `rowMatchesSpec` deliberately
 * never filters on it — exclusionary semantics would hide themed facts from
 * every non-matching run. It rides TagFilters so it normalizes and hashes
 * with the other axes and needs no schema change (`tag_filters` is jsonb).
 */
export interface TagFilters {
  channels?: string[];
  products?: string[];
  audiences?: string[];
  stages?: string[];
  themes?: string[];
}

export const TAG_FILTER_AXES = [
  'channels',
  'products',
  'audiences',
  'stages',
  'themes',
] as const;

/** The compile-facing row shape (persisted rows narrow to this). */
export interface BrandContextRow {
  rowId: string;
  rowType: BrandContextRowType;
  version: number;
  priority: number;
  tagFilters: TagFilters;
  content: Record<string, unknown>;
}

/** A persisted brand_context_rows row (camelCase domain shape). */
export interface StoredBrandContextRow extends BrandContextRow {
  id: string;
  organizationId: string;
  brandProfileId: string;
  contentHash: string;
  sourceRef: Record<string, unknown>;
  supersededAt: string | null;
  retiredAt: string | null;
  createdAt: string;
}

/** The task spec — every per-run choice is made upstream and lands here. */
export interface CompileSpec {
  platform: 'meta' | 'google' | 'tiktok';
  aspectRatio: string;
  goal: string;
  /** `persona_x@v2` (pinned) or `persona_x` (max version in input rows). */
  personaRef: string;
  angle: string;
  candidates: number;
  /** Optional product scoping (the `products` tag axis). */
  product?: string;
  /**
   * Picked key-message fact, `fact_x@vN` (pinned) or `fact_x` (max version).
   * Force-included FIRST in the facts slot and BYPASSES tag filtering — an
   * explicit human pick outranks the deterministic tag heuristic. Counts
   * against FACTS_SLOT_BUDGET.
   */
  keyMessageRef?: string;
  /**
   * Explicitly flagged free-text overrides, fingerprint-visible via the spec
   * echo (slots unchanged). Extensible (keyMessage/angle may come later);
   * only `audience` ships in compiler v2. Never pass an empty object.
   */
  overrides?: { audience?: string };
  /**
   * The run's taxonomy angle value (ONE per run) when the composed angle
   * provably came from the strategy selector — see `resolveSpecAngleTheme`.
   * Facts tagged with this theme sort FIRST in the facts slot (ranking tier,
   * never a filter). Absent = pre-v3 behavior, pure priority order.
   */
  angleTheme?: string;
  /**
   * Derived performance lessons to ground this run in (Workstream H, compiler
   * v4), resolved exactly like `keyMessageRef` and capped at
   * `LESSONS_SLOT_BUDGET`. Chosen upstream: the briefs route matches lessons
   * against the angle/hook/format this run actually picked, so a pack can
   * reinforce the strategy but never contradict it.
   *
   * Conditionally spread into the spec echo, so an absent field leaves pack
   * bytes byte-identical to a pre-H compile (same rule as `product`).
   */
  lessonRefs?: string[];
}

export interface RowRef {
  /** The semantic row_id slug, NOT the uuid PK. */
  id: string;
  version: number;
}

export interface SlotEntry {
  id: string;
  version: number;
  content: Record<string, unknown>;
}

/**
 * Fixed-shape pack slots. `persona` is the fifth slot (user decision
 * 2026-07-19 amending the original four row types): exactly one entry,
 * selected only via `spec.personaRef`, never via tag filtering.
 */
export interface PackSlots {
  facts: SlotEntry[];
  voice: SlotEntry[];
  rules: SlotEntry[];
  assets: SlotEntry[];
  persona: SlotEntry;
}

export interface BrandContextPack {
  meta: {
    compilerVersion: number;
    rendererVersions: { copy: number; image: number; judge: number };
    /**
     * Tenant-scopes the fingerprint by construction: identical stores/specs
     * in two profiles hash differently, so the fingerprint text PK is safe
     * cross-tenant.
     */
    brandProfileId: string;
    spec: CompileSpec;
    /** Every included row incl. the persona, sorted by id asc (code-unit). */
    rowRefs: RowRef[];
  };
  slots: PackSlots;
}

export interface CompileResult {
  pack: BrandContextPack;
  fingerprint: string;
}

export interface IngestResult {
  inserted: number;
  superseded: number;
  retired: number;
  unchanged: number;
}

/**
 * Bump on any change that alters pack bytes for identical inputs.
 * v2 (2026-07-31): keyMessageRef pinning + overrides in the spec echo.
 * v3 (2026-08-12): relevance-aware fact selection — the `themes` tag axis
 * (ranking tier in selectFacts) + `spec.angleTheme` in the spec echo.
 */
export const COMPILER_VERSION = 4;
// v2 across the board (2026-08-04 quality rework): copy — angle expressed
// not quoted, execution guidance + BANNED_AD_SPEAK; image — clean-image
// doctrine (packaging text/logo REQUIRED faithful, added text/bands/CTA
// pills banned, scene relevance, negative-space machinery deleted); judge —
// structural items no_added_text / product_fidelity (conditional) /
// scene_relevance with per-item `enforced` flags (enforce_structural mode).
// image v3 (2026-08-04 incident fix): quality segment + unbranded-packaging
// constraint when no product references exist (ungrounded models invented a
// competitor brand + a fake disclaimer on the first live run).
// copy v3 + image v4 + judge v3 (2026-08-05 prompt-injection hardening): ALL
// THREE renderers collapse the internal whitespace of every row-derived
// string they render (fact/voice/rule statements, persona fields and
// verbatims, palette values), so review-derived text carrying newlines can no
// longer forge a "## " section header, an extra checklist line, or a broken
// image segment. Spec-echo fields render as authored in every renderer.
// image v5 + judge v4 (2026-09-22 near-identical-images fix): image drops the
// boilerplate `Concept:` clause when spec.angleTheme is set, ALWAYS renders
// one brand-fact key claim (lessons skipped; via the scene, never as text)
// even with product references, and scene relevance now permits stylised /
// conceptual compositions; judge scene relevance moves to @r3 to match.
export const RENDERER_VERSIONS = { copy: 3, image: 5, judge: 4 } as const;

// Per-slot budget caps (locked architecture decision 2).
export const FACTS_SLOT_BUDGET = 3;
/**
 * Derived performance lessons ride the facts slot but get their OWN reserved
 * capacity (Workstream H) — they are appended AFTER the brand facts and never
 * compete for the three.
 *
 * Two reasons it is a reservation rather than a contest. A lesson losing every
 * contest would make conditioning a no-op nobody noticed; a lesson WINNING one
 * would spend a grounding slot the copywriter needs for a real brand claim.
 * Appended-last keeps the brand facts first; `renderImagePrompt` (image v5)
 * additionally skips lesson ids when it lifts the first fact statement as the
 * image's key claim, since a strategy directive is not a key claim.
 */
export const LESSONS_SLOT_BUDGET = 1;
export const VOICE_SLOT_BUDGET = 2;
/** Rules are never dropped — every compliance rule rides every pack. */
export const RULES_SLOT_BUDGET = Number.POSITIVE_INFINITY;
export const ASSETS_SLOT_BUDGET = 4;
export const PERSONA_SLOT_BUDGET = 1;

/**
 * Ingest priority derivation. Machine confidence caps below 1.0 (reserved
 * for humans, lib/brand-object/CLAUDE.md), so a confirmed fact always
 * outranks a candidate: min confirmed 200 >= max candidate ~199 (the
 * confidence-1.0 rounding edge is covered by the rowId tie-break).
 */
export const PRIORITY_STATUS_BASE: Record<'confirmed' | 'candidate', number> = {
  confirmed: 200,
  candidate: 100,
};
export const PRIORITY_CONFIDENCE_SCALE = 100;
/**
 * Org-level Brand Guidelines (`organizations.settings.brandSummary`) ingested
 * as the BASE layer of a SINGLE-brand org's pack (plan item 8). Flat — no
 * confidence scaling — and strictly BELOW the candidate floor (100), so ANY
 * profile-authored brand_fact outranks it. That priority gap IS the
 * "per-profile overrides org on the same topic" cascade: the compiler's
 * (priority desc, rowId asc) sort and the slot budgets do all the work, and
 * no selection logic changes. Never raise this to >= 100.
 */
export const PRIORITY_ORG_GUIDELINE = 50;
// Founder-provided brand-kit assets rank above every machine-derived fact.
export const PRIORITY_ASSET_LOGO = 260;
export const PRIORITY_ASSET_COLORS = 258;
export const PRIORITY_ASSET_FONTS = 256;
export const PRIORITY_ASSET_PRODUCT_IMAGE = 250;

/** Structured error the routes map to an `AfError` (synthesis precedent). */
export class BrandContextError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly remediation: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'BrandContextError';
  }
}

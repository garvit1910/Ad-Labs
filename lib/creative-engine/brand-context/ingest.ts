/**
 * Deterministic ingestion mapping — PURE. Transforms live brand_facts rows
 * (via the lib/brand-object/live-facts door) + the org brand kit into
 * desired brand-context rows, and diffs them against the stored latest
 * versions. No LLM, no IO, no clock: Phase-1 tagging is derived only from
 * existing persona metadata (channels/products start empty = everywhere).
 */
import {
  BrandContextError,
  PRIORITY_ASSET_COLORS,
  PRIORITY_ASSET_FONTS,
  PRIORITY_ASSET_LOGO,
  PRIORITY_ASSET_PRODUCT_IMAGE,
  PRIORITY_CONFIDENCE_SCALE,
  PRIORITY_ORG_GUIDELINE,
  PRIORITY_STATUS_BASE,
  type BrandContextRowType,
  type StoredBrandContextRow,
  type TagFilters,
} from './types';
import { rowContentHash } from './fingerprint';
import {
  LESSON_CONTENT_SECTION,
  LESSON_ROW_ID_PREFIX,
  LESSON_SECTION,
  lessonDirective,
  parseLessonFactKey,
} from './lessons';
import { deriveFactThemes } from './themes';

/**
 * A live brand_facts row as ingest consumes it. Structurally compatible
 * with `InsightFact` (lib/brand-object/insights) so the live-facts door
 * output is directly assignable.
 */
export interface UpstreamFact {
  id: string;
  section: string;
  fact_key: string;
  statement: string;
  details: Record<string, unknown>;
  confidence: number;
  status: string;
}

/**
 * Structural mirror of `organizations.settings.brandAssets`
 * (BrandAssetsSchema, app/api/creative-studio/shared/schemas.ts). Redeclared
 * here because lib/ must not import from app/.
 */
export interface BrandKitAssets {
  logo?: { url: string; fileName?: string };
  colors?: { primary?: string; secondary?: string; accent?: string };
  fonts?: { heading?: string; body?: string };
  productImages?: Array<{ id: string; url: string; fileName?: string }>;
}

/**
 * Structural mirror of `OrganizationBrandSummary`
 * (types/organization.ts) — the org-level Brand Guidelines blob stored at
 * `organizations.settings.brandSummary`. Redeclared here for the same reason
 * as `BrandKitAssets` above (lib/ must not depend on the app-level types),
 * and every field is optional because the stored blob is open jsonb written
 * by an older settings form.
 */
export interface OrgBrandGuidelines {
  brandVoice?: string;
  targetAudience?: string;
  valuePropositions?: string[];
  keyMessages?: string[];
  competitiveAdvantages?: string[];
  /** Provenance only — never ingested as content. */
  generatedAt?: string;
  sourceUrl?: string;
}

export interface DesiredRow {
  rowId: string;
  rowType: BrandContextRowType;
  priority: number;
  tagFilters: TagFilters;
  content: Record<string, unknown>;
  sourceRef: Record<string, unknown>;
}

/** Lowercase, non-alphanumeric runs → `_`, trimmed; never empty. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug.length > 0 ? slug : 'unknown';
}

function factStatus(status: string): 'confirmed' | 'candidate' {
  return status === 'confirmed' ? 'confirmed' : 'candidate';
}

export function priorityForFact(status: string, confidence: number): number {
  return (
    PRIORITY_STATUS_BASE[factStatus(status)] +
    Math.round(confidence * PRIORITY_CONFIDENCE_SCALE)
  );
}

function rowTypeForSection(section: string): BrandContextRowType {
  switch (section) {
    case 'voice':
      return 'voice';
    case 'compliance':
      return 'rule';
    case 'persona':
      return 'persona';
    default:
      // Open-strings posture: unknown future sections land as facts with the
      // section-qualified row_id scheme — forward-compatible by construction.
      return 'fact';
  }
}

function rowIdForFact(section: string, factKey: string): string {
  switch (rowTypeForSection(section)) {
    case 'voice':
      return `voice_${slugify(factKey)}`;
    case 'rule':
      return `rule_${slugify(factKey)}`;
    case 'persona':
      return `persona_${slugify(factKey)}`;
    default:
      // Section is slugified too: it is an OPEN string at the DB (a new
      // section ships with no migration), so an unslugified one could emit a
      // row_id with spaces/uppercase or collide with a sibling. Every current
      // BrandSection value is already slug-safe (lowercase + underscores), so
      // this changes no existing row_id and churns no stored data.
      return `fact_${slugify(section)}_${slugify(factKey)}`;
  }
}

interface PersonaCitation {
  audiences: Set<string>;
  stages: Set<string>;
}

type CitationRef = { fact_id?: unknown };

/** fact uuid → the persona rows citing it (audience = citation signal). */
function collectPersonaCitations(
  facts: UpstreamFact[],
): Map<string, PersonaCitation> {
  const citations = new Map<string, PersonaCitation>();
  for (const fact of facts) {
    if (fact.section !== 'persona') continue;
    const personaRowId = rowIdForFact(fact.section, fact.fact_key);
    const stage =
      typeof fact.details.awarenessStage === 'string'
        ? fact.details.awarenessStage
        : null;
    const refs: CitationRef[] = [
      ...((fact.details.pains as CitationRef[] | undefined) ?? []),
      ...((fact.details.desires as CitationRef[] | undefined) ?? []),
      ...((fact.details.objections as CitationRef[] | undefined) ?? []),
    ];
    for (const ref of refs) {
      if (typeof ref?.fact_id !== 'string') continue;
      let entry = citations.get(ref.fact_id);
      if (!entry) {
        entry = { audiences: new Set(), stages: new Set() };
        citations.set(ref.fact_id, entry);
      }
      entry.audiences.add(personaRowId);
      if (stage) entry.stages.add(stage);
    }
  }
  return citations;
}

function contentForFact(fact: UpstreamFact): Record<string, unknown> {
  switch (rowTypeForSection(fact.section)) {
    case 'voice':
      return { kind: 'voice', statement: fact.statement, details: fact.details };
    case 'rule':
      return { kind: 'rule', statement: fact.statement, details: fact.details };
    case 'persona':
      // The persona card verbatim (name/description/awarenessStage/pains/
      // desires/objections/verbatims — personas/prompt.ts validated shape).
      // `kind` is set AFTER the spread: details is open jsonb, and a details
      // key literally named `kind` would otherwise clobber the discriminator
      // every downstream reader narrows on.
      return { ...fact.details, kind: 'persona' };
    default:
      return {
        kind: 'fact',
        section: fact.section,
        statement: fact.statement,
        details: fact.details,
      };
  }
}

/**
 * Sections that are deliberately NOT brand context.
 *
 * `performance_prior` holds derived performance LESSONS ("problem_callout hooks
 * returned 3.2x platform ROAS over $4,100"). Those are numbers about how ads
 * PERFORMED, not facts about who the brand IS. Letting them fall through the
 * open-strings default in `rowTypeForSection` would land their RAW statements
 * ("3.20x platform ROAS over 4100.00 spend") as ordinary `fact` rows — under
 * the copy renderer's `## Brand facts` header, which the system prompt calls
 * ground truth and tells the model to quote numbers from verbatim. That is the
 * real hazard, and it is why this exclusion stays even now that Workstream H
 * conditions generation on lessons: H maps them through
 * `mapPerformanceLessonRows` into a number-free directive with its own reserved
 * slot, never through here.
 *
 * ⚠️ A previous version of this note claimed a `COMPILER_VERSION` bump strands
 * in-flight briefs on `RENDERER_VERSION_MISMATCH`. That is FALSE and was
 * verified false: `compilerVersion` is written, echoed and displayed, and
 * asserted NOWHERE at runtime — only `assertRendererVersion` gates rendering.
 * (Corrected 2026-08-27; the same false claim lived in this file, in
 * ingest.test.ts, and in lib/creative-engine/CLAUDE.md.)
 */
const NON_CONTEXT_SECTIONS: ReadonlySet<string> = new Set(['performance_prior']);

export function mapBrandFactsToRows(facts: UpstreamFact[]): DesiredRow[] {
  // Filtered BEFORE citation collection: an excluded section can never be a
  // persona citation target, and this keeps the map body's indentation intact.
  const contextFacts = facts.filter((fact) => !NON_CONTEXT_SECTIONS.has(fact.section));
  const citations = collectPersonaCitations(contextFacts);
  return contextFacts.map((fact) => {
    const rowType = rowTypeForSection(fact.section);
    const tagFilters: TagFilters = {};
    if (rowType !== 'persona') {
      const cited = citations.get(fact.id);
      if (cited) {
        tagFilters.audiences = [...cited.audiences].sort();
        if (cited.stages.size > 0) tagFilters.stages = [...cited.stages].sort();
      }
    }
    // Deterministic angle themes — fact rows only, and only for the
    // grounding-appropriate sections (themes.ts owns the section scoping).
    // Ranking-only axis: it never affects whether a row is eligible.
    if (rowType === 'fact') {
      const themes = deriveFactThemes(fact);
      if (themes.length > 0) tagFilters.themes = themes;
    }
    return {
      rowId: rowIdForFact(fact.section, fact.fact_key),
      rowType,
      priority: priorityForFact(fact.status, fact.confidence),
      tagFilters,
      content: contentForFact(fact),
      sourceRef: {
        kind: 'brand_fact',
        factId: fact.id,
        section: fact.section,
        factKey: fact.fact_key,
        status: factStatus(fact.status),
        confidence: fact.confidence,
      },
    };
  });
}

export function mapBrandKitToRows(
  brandAssets: BrandKitAssets | null | undefined,
): DesiredRow[] {
  if (!brandAssets) return [];
  const rows: DesiredRow[] = [];

  if (brandAssets.logo?.url) {
    const content: Record<string, unknown> = {
      kind: 'logo',
      url: brandAssets.logo.url,
    };
    if (brandAssets.logo.fileName) content.fileName = brandAssets.logo.fileName;
    rows.push({
      rowId: 'asset_brand_logo',
      rowType: 'asset',
      priority: PRIORITY_ASSET_LOGO,
      tagFilters: {},
      content,
      sourceRef: { kind: 'brand_kit', assetKind: 'logo' },
    });
  }

  const colors = brandAssets.colors ?? {};
  if (colors.primary || colors.secondary || colors.accent) {
    const content: Record<string, unknown> = { kind: 'color_palette' };
    if (colors.primary) content.primary = colors.primary;
    if (colors.secondary) content.secondary = colors.secondary;
    if (colors.accent) content.accent = colors.accent;
    rows.push({
      rowId: 'asset_brand_colors',
      rowType: 'asset',
      priority: PRIORITY_ASSET_COLORS,
      tagFilters: {},
      content,
      sourceRef: { kind: 'brand_kit', assetKind: 'color_palette' },
    });
  }

  const fonts = brandAssets.fonts ?? {};
  if (fonts.heading || fonts.body) {
    const content: Record<string, unknown> = { kind: 'font_pair' };
    if (fonts.heading) content.heading = fonts.heading;
    if (fonts.body) content.body = fonts.body;
    rows.push({
      rowId: 'asset_brand_fonts',
      rowType: 'asset',
      priority: PRIORITY_ASSET_FONTS,
      tagFilters: {},
      content,
      sourceRef: { kind: 'brand_kit', assetKind: 'font_pair' },
    });
  }

  for (const image of brandAssets.productImages ?? []) {
    if (!image?.id || !image.url) continue;
    const content: Record<string, unknown> = {
      kind: 'product_image',
      id: image.id,
      url: image.url,
    };
    // uploadedAt is provenance, not content — including it would churn
    // versions on every re-save.
    if (image.fileName) content.fileName = image.fileName;
    rows.push({
      rowId: `asset_product_image_${slugify(image.id)}`,
      rowType: 'asset',
      priority: PRIORITY_ASSET_PRODUCT_IMAGE,
      tagFilters: {},
      content,
      sourceRef: {
        kind: 'brand_kit',
        assetKind: 'product_image',
        productImageId: image.id,
      },
    });
  }

  return rows;
}

/**
 * Per-array cap on org-guideline rows. `settings.brandSummary` is an open
 * jsonb blob written by a website-generation step, so a runaway array could
 * otherwise flood ingest with dozens of priority-50 rows (harmless to pack
 * SELECTION — slot budgets cap that — but real row churn in the store).
 * Five is well past what the settings form authors in practice.
 */
export const ORG_GUIDELINE_ARRAY_CAP = 5;

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cappedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const cleaned = cleanString(entry);
    if (cleaned === null) continue;
    out.push(cleaned);
    if (out.length >= ORG_GUIDELINE_ARRAY_CAP) break;
  }
  return out;
}

/**
 * Org-level Brand Guidelines → LOW-priority (`PRIORITY_ORG_GUIDELINE`) rows —
 * the BASE layer of a single-brand org's pack (plan item 8). The gate that
 * decides whether these are read at all lives in the store
 * (`loadOrgGuidelines`); this mapping is pure and unconditional.
 *
 * Shape rules:
 * - One row per array element (never a JSON-array blob) — matches the
 *   brand_facts granularity every renderer already expects.
 * - `brandName` / `productsOrServices` / `industryCategory` are deliberately
 *   NOT ingested: the brand profile row already carries them.
 * - `targetAudience` lands as a plain `positioning` fact, NOT a persona row.
 *   Personas are a structured card selected exactly once via `spec.personaRef`
 *   (compile.ts) — a bare audience string cannot be one, and synthesizing a
 *   half-empty persona would make it selectable.
 * - Provenance (`sourceUrl`/`generatedAt`) rides `sourceRef` ONLY. `sourceRef`
 *   is excluded from `rowContentHash`, so re-generating the summary without
 *   changing its text mints no new versions (same rule as the productImages
 *   `uploadedAt` exclusion above).
 */
export function mapOrgGuidelinesToRows(
  guidelines: OrgBrandGuidelines | null | undefined,
): DesiredRow[] {
  if (!guidelines || typeof guidelines !== 'object') return [];

  const provenance: Record<string, unknown> = {};
  const sourceUrl = cleanString(guidelines.sourceUrl);
  if (sourceUrl) provenance.sourceUrl = sourceUrl;
  const generatedAt = cleanString(guidelines.generatedAt);
  if (generatedAt) provenance.generatedAt = generatedAt;

  const rows: DesiredRow[] = [];

  const push = (
    section: string,
    factKey: string,
    statement: string,
    field: string,
  ): void => {
    const rowType = rowTypeForSection(section);
    const tagFilters: TagFilters = {};
    if (rowType === 'fact') {
      // Same ranking axis as any other fact row — an org value prop should
      // rank on-theme exactly like a profile-authored one.
      const themes = deriveFactThemes({
        section,
        fact_key: factKey,
        statement,
      });
      if (themes.length > 0) tagFilters.themes = themes;
    }
    rows.push({
      rowId: rowIdForFact(section, factKey),
      rowType,
      priority: PRIORITY_ORG_GUIDELINE,
      tagFilters,
      content:
        rowType === 'voice'
          ? { kind: 'voice', statement, details: {} }
          : { kind: 'fact', section, statement, details: {} },
      sourceRef: { kind: 'org_guidelines', field, ...provenance },
    });
  };

  const brandVoice = cleanString(guidelines.brandVoice);
  if (brandVoice) push('voice', 'org_brand_voice', brandVoice, 'brandVoice');

  cappedStrings(guidelines.valuePropositions).forEach((statement, index) => {
    push(
      'value_prop',
      `org_value_prop_${index + 1}`,
      statement,
      'valuePropositions',
    );
  });

  cappedStrings(guidelines.keyMessages).forEach((statement, index) => {
    push('usp', `org_key_message_${index + 1}`, statement, 'keyMessages');
  });

  cappedStrings(guidelines.competitiveAdvantages).forEach(
    (statement, index) => {
      push(
        'positioning',
        `org_competitive_advantage_${index + 1}`,
        statement,
        'competitiveAdvantages',
      );
    },
  );

  const targetAudience = cleanString(guidelines.targetAudience);
  if (targetAudience) {
    push(
      'positioning',
      'org_target_audience',
      targetAudience,
      'targetAudience',
    );
  }

  return rows;
}

/**
 * Derived performance lessons → their own deliberately-shaped row family
 * (Workstream H). Gated: `buildDesiredRows` only calls this when the caller
 * says so, so an unconfigured fleet ingests zero lesson rows and every pack
 * stays byte-identical to pre-H.
 *
 * NOT a widening of `mapBrandFactsToRows` — that function still excludes
 * `performance_prior` and its two locking tests are untouched. A lesson is
 * `rowType: 'fact'` (so no `PackSlots` shape change and no renderer bump) but
 * it is selected by explicit ref into its own reserved slot, never by competing
 * in the brand-fact budget.
 *
 * What a lesson row deliberately does NOT carry:
 *  - `details`. Ordinary fact rows spread it into pack content verbatim; a
 *    lesson's details hold ROAS, capture ratio and belief curves, none of which
 *    belong in hashed pack bytes or anywhere near a copy prompt.
 *  - themes. Selection is by explicit ref, not by the ranking tier, so a theme
 *    would only add hash churn.
 *  - tag filters. A lesson about what works for this brand applies wherever the
 *    run that matched it applies.
 */
export function mapPerformanceLessonRows(facts: UpstreamFact[]): DesiredRow[] {
  const rows: DesiredRow[] = [];
  for (const fact of facts) {
    if (fact.section !== LESSON_SECTION) continue;
    const identity = parseLessonFactKey(fact.fact_key);
    if (!identity) continue;
    const statement = lessonDirective(identity);
    if (!statement) continue;

    rows.push({
      rowId: `${LESSON_ROW_ID_PREFIX}${slugify(fact.fact_key)}`,
      rowType: 'fact',
      // Lessons never contend with brand facts for a slot, so this only orders
      // lessons among themselves — highest-confidence lesson first.
      priority: priorityForFact(fact.status, fact.confidence),
      tagFilters: {},
      content: {
        kind: 'fact',
        section: LESSON_CONTENT_SECTION,
        statement,
      },
      sourceRef: {
        kind: 'brand_fact',
        factId: fact.id,
        // The TRUE section — `content.section` is the renderer's label. This is
        // also the handle the briefs route filters on so a lesson can never be
        // counted as a proof fact for an ad's claims.
        section: fact.section,
        factKey: fact.fact_key,
        status: factStatus(fact.status),
        confidence: fact.confidence,
      },
    });
  }
  return rows;
}

export interface BuildDesiredRowsOptions {
  /**
   * Ingest derived performance lessons as their own row family (Workstream H).
   * The decision is the CALLER'S — this module stays pure and env-free; the
   * gate lives in `BrandContextStore.ingest` (not the routes, because scripts
   * ingest too — same placement rule as the org-guidelines profile gate).
   */
  includePerformanceLessons?: boolean;
}

export function buildDesiredRows(
  facts: UpstreamFact[],
  brandAssets: BrandKitAssets | null | undefined,
  orgGuidelines?: OrgBrandGuidelines | null,
  options?: BuildDesiredRowsOptions,
): DesiredRow[] {
  const rows = [
    ...mapBrandFactsToRows(facts),
    ...(options?.includePerformanceLessons ? mapPerformanceLessonRows(facts) : []),
    ...mapBrandKitToRows(brandAssets),
  ];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.rowId)) {
      throw new BrandContextError(
        'DUPLICATE_ROW_ID',
        `Ingest produced two rows with row_id "${row.rowId}"`,
        'Upstream fact keys collided after slugification; rename the conflicting fact_key',
        500,
      );
    }
    seen.add(row.rowId);
  }

  // Cross-source collision resolution. Within ONE source a duplicate row_id is
  // a bug and still throws (above, and again below for org-vs-org); ACROSS
  // sources the org-guideline row is silently dropped, because the profile row
  // always outranks it anyway (priority >= 100 vs 50). That drop IS the
  // "same topic → profile wins" override, made explicit instead of leaving two
  // rows fighting over one row_id.
  const orgSeen = new Set<string>();
  for (const row of mapOrgGuidelinesToRows(orgGuidelines)) {
    if (orgSeen.has(row.rowId)) {
      throw new BrandContextError(
        'DUPLICATE_ROW_ID',
        `Ingest produced two rows with row_id "${row.rowId}"`,
        'Org brand guidelines produced a colliding row_id; edit the conflicting guideline field',
        500,
      );
    }
    orgSeen.add(row.rowId);
    if (seen.has(row.rowId)) continue;
    seen.add(row.rowId);
    rows.push(row);
  }

  return rows;
}

export interface RowDiff {
  toInsert: Array<DesiredRow & { version: number; contentHash: string }>;
  /** Stored uuid PKs to stamp superseded_at (BEFORE inserting). */
  toSupersede: string[];
  /** Stored uuid PKs to stamp retired_at (upstream identity vanished). */
  toRetire: string[];
  unchanged: number;
}

/**
 * Pure version diff. `latest` must be the latest version per row_id
 * (superseded_at IS NULL), including retired rows.
 *
 * Transitions: absent → insert v1; hash equal + live → no write; hash equal
 * + retired → re-insert v+1 (identity reappeared; new version is live);
 * hash differs → supersede + insert v+1; live row missing upstream → retire.
 */
export function diffDesiredRows(
  desired: DesiredRow[],
  latest: StoredBrandContextRow[],
): RowDiff {
  const latestByRowId = new Map(latest.map((row) => [row.rowId, row]));
  const diff: RowDiff = { toInsert: [], toSupersede: [], toRetire: [], unchanged: 0 };

  for (const row of desired) {
    const contentHash = rowContentHash(row);
    const existing = latestByRowId.get(row.rowId);
    if (!existing) {
      diff.toInsert.push({ ...row, version: 1, contentHash });
      continue;
    }
    if (existing.contentHash === contentHash && existing.retiredAt === null) {
      diff.unchanged += 1;
      continue;
    }
    // Changed content, or a retired identity reappearing: new version.
    diff.toSupersede.push(existing.id);
    diff.toInsert.push({ ...row, version: existing.version + 1, contentHash });
  }

  const desiredIds = new Set(desired.map((row) => row.rowId));
  for (const row of latest) {
    if (!desiredIds.has(row.rowId) && row.retiredAt === null) {
      diff.toRetire.push(row.id);
    }
  }

  return diff;
}

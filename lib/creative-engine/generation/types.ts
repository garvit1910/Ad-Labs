/**
 * Creative Engine Phase 3 — generation layer contracts.
 *
 * THE parallelization seam (plan: tasks/creative-engine-phase3-generation-plan.md):
 * everything in `lib/creative-engine/generation/` builds against `CreativeBrief`.
 * Producers today: the interim brief composer (human form / agent compose_brief).
 * Producer later: Phase 2 `strategy_concepts` via a thin `conceptToBrief` adapter.
 * Do NOT couple pipeline code to any single producer.
 *
 * Genome rule (non-negotiable): every generated output carries a complete
 * `CreativeGenome` stamped AT CREATION — concept-level performance attribution
 * (Phase 4) and the anonymized industry layer (Phase 5) both depend on it.
 */

// twitter: pre-release, gated. X creative generation is outside A0.
export type CreativePlatform = 'meta' | 'tiktok' | 'google';

export type AspectRatio = '1:1' | '4:5' | '9:16' | '16:9';

export type BriefSource = 'strategy_concept' | 'manual' | 'agent';

// The genome `style` dimension is the closed `VISUAL_STYLES` enum, shared with
// competitor ad-intel (`ad_labels.style`) so both key `performance_memory`'s
// `style` dimension on the same values. Rich art direction lives in
// `CreativeBrief.styleDirection` (prose); `style` is the enum bucket.
export type { VisualStyle } from '@/services/ad-library/label-taxonomy';
import type {
  AdFormat,
  Angle,
  Persona,
  VisualStyle,
} from '@/services/ad-library/label-taxonomy';
import type { GenomeProvenance } from './genome-completeness';
import type { ReplaceAdAction } from '../publish/replace-target';

export interface BrandColors {
  primary?: string;
  secondary?: string;
  accent?: string;
}

export interface BrandFonts {
  heading?: string;
  body?: string;
}

export interface BrandKitProductImage {
  id: string;
  url: string;
  fileName?: string;
}

/**
 * Visual brand inputs for generation. Interim source:
 * `organizations.settings.brandAssets` (ported settings shape). Phase 1
 * integration re-sources this from Brand Object T0/T1 facts — same shape.
 */
export interface CreativeBrandKit {
  logoUrl?: string;
  colors?: BrandColors;
  fonts?: BrandFonts;
  productImages: BrandKitProductImage[];
}

export interface BriefCompliance {
  /** Claims that must NOT appear in any copy or in-image text (substring, case-insensitive). */
  prohibitedClaims: string[];
  /** Disclaimer strings that must appear VERBATIM on the final creative (overlay-rendered). */
  requiredDisclaimers: string[];
  industry?: string;
}

/** The Phase 2 ↔ Phase 3 contract. */
export interface CreativeBrief {
  briefId: string;
  organizationId: string;
  source: BriefSource;
  /** strategy_concepts.id once Phase 2 lands; absent for manual/agent briefs. */
  conceptId?: string;

  // Strategy
  angle: string;
  persona: string;
  awarenessStage?: string;
  coreMessage: string;
  hooks: string[];
  headline?: string;
  primaryText?: string;
  cta: string;
  visualDirection: string;
  /**
   * Closed visual-style bucket (`VISUAL_STYLES`) — the genome-stamped dimension
   * shared with competitor style intel. Rich prose direction is
   * `styleDirection`; this is the enum. Old persisted briefs may hold prose
   * here — `buildGenome` normalizes at the stamp point (idempotent for enums).
   */
  style: VisualStyle;
  /**
   * Rich art-direction prose (blueprint style + optional brand-voice tone).
   * Feeds the image-gen prompt / provider / ranking. Absent on OLD persisted
   * briefs — read sites fall back to `style` (`styleDirection ?? style`).
   */
  styleDirection?: string;
  /**
   * Closed-taxonomy roll-ups of `angle` / `persona`, resolved by
   * `canonicalize.ts` in the briefs route (the composer is pure and DB-free, so
   * it cannot resolve them itself). ADDITIVE — the prose fields above stay the
   * verbatim attribution keys. Optional on the type because briefs persisted
   * before Workstream B carry neither; `buildGenome` floors those to `'other'`
   * rather than letting a resumed run fail the hard `genome_complete` gate.
   */
  angleUniversal?: Angle;
  personaUniversal?: Persona;
  /** brand_facts ids grounding the claims (Phase 1); empty until then. */
  proofFactIds?: string[];

  // Targeting
  platform: CreativePlatform;
  aspectRatios: AspectRatio[];

  // Gate inputs
  compliance: BriefCompliance;
  brandLexicon?: { avoid: string[] };

  // Visual grounding
  brandKit: CreativeBrandKit;
}

/** Stamped on EVERY generated creative at creation. */
export interface CreativeGenome {
  briefId: string;
  conceptId?: string;
  brandFactIds: string[];
  angle: string;
  persona: string;
  /**
   * Closed-taxonomy twins of `angle`/`persona` (Workstream B). These are what
   * the rollup emits as the `angle_universal` / `persona_universal` dimensions,
   * so a generated ad and a labeled imported ad finally file on the same shelf.
   * The prose fields above remain the concept-attribution keys and are never
   * rewritten. Always present on new genomes (`canonicalize.ts` is total);
   * absent on rows stamped before B until the backfill runs.
   */
  angleUniversal: Angle;
  personaUniversal: Persona;
  /**
   * Per-dimension provenance for the four canonical attribution dimensions
   * (`genome-completeness.ts`, 2026-09-22). `'other'` is a legal taxonomy
   * member on the LABEL side, so on the genome side it is ambiguous on its own:
   * the marker is what separates "the composer pulled the `other` cell" from
   * "this genome never stated a cell at all". `unresolved` / `unmapped` mean
   * the value beside them is NOT a claim and the loop must not learn on it.
   * Absent on rows stamped before this landed.
   */
  genomeProvenance?: GenomeProvenance;
  hookArchetype?: string;
  /**
   * The StrategyGroup's producible ad format. Chosen by `strategy.ts` since
   * 2026-08 but previously stamped only in `generationParams.format`, so the
   * rollup could not emit a `format` dimension the label side has always had.
   * OPTIONAL and deliberately NOT in `REQUIRED_GENOME_FIELDS` — copy-only (RSA)
   * and pre-strategy runs have no format, and `genome_complete` is a hard,
   * non-repairable kill gate.
   */
  format?: AdFormat;
  style: string;
  provider: string;
  model: string;
  generationParams: Record<string, unknown>;
  /**
   * Deterministic overlay outcome — TRUE only when the disclaimer-strip
   * compositor actually applied a strip to this candidate's bytes, FALSE when
   * the brief had no disclaimers or the overlay was skipped/failed (best-effort
   * failure keeps un-stripped bytes → false). Stamped in the pipeline at the
   * same point as `generationParams.disclaimerOverlay`; never inferred from
   * prompt/brief copy. The genome-side rollup emits it as the `text_overlay`
   * performance dimension. Absent on historical (pre-PR4) rows.
   */
  textOverlay?: boolean;
  /** Rank provenance — set at the ranking stage. */
  rankScore?: number;
  judgeVersion?: string;
}

// ── Providers ────────────────────────────────────────────────────────────────

export interface ProviderSize {
  width: number;
  height: number;
}

export interface CreativeProviderCapabilities {
  textToImage: boolean;
  imageEdit: boolean;
  /** Max reference-image inputs (0 = unsupported). */
  referenceImages: number;
  /** Whether in-image text rendering is trustworthy (hybrid-text routing). */
  inImageText: 'good' | 'unreliable';
  sizes: ProviderSize[];
}

/**
 * Provider quality tier. Providers with tiered pricing (OpenAI gpt-image-2:
 * ~$0.006 low / ~$0.05 medium / ~$0.21 high per image) honor it; providers
 * without tiers ignore it. Enables the cheap-wide → judge-rank → premium
 * re-render economics (re-render stage is a planned follow-up).
 */
export type ImageQuality = 'low' | 'medium' | 'high';

export interface GenerationRequest {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  style?: string;
  /** Quality/pricing tier — see {@link ImageQuality}. Omitted → provider default. */
  quality?: ImageQuality;
  /** Product/logo reference image URLs — pass when capabilities.referenceImages > 0. */
  referenceImages?: string[];
  /** Abort/timeout signal; providers must respect it. */
  signal?: AbortSignal;
}

export interface GenerationResult {
  imageBuffer: Buffer;
  contentType: string;
  /** Provider-revised prompt when reported. */
  revisedPrompt?: string;
  model: string;
  metadata?: Record<string, unknown>;
}

export interface ImageRef {
  /** Public URL or data reference to the image being edited. */
  url: string;
}

export interface ProviderEditOptions {
  signal?: AbortSignal;
  /**
   * Requested output canvas for the edit. Providers that support it re-frame
   * the result at this size (OpenAI /edits `size`, Gemini imageConfig
   * aspectRatio) — the aspect-ratio outpaint path. Providers without native
   * support ignore it (the instruction still carries the ratio ask).
   */
  targetSize?: ProviderSize;
}

export interface CreativeImageProvider {
  name: string;
  /**
   * The model this provider WILL call (override ?? env resolver), known before
   * any call — so a candidate whose call fails still records the intended
   * model instead of 'unknown'. The model a successful call RETURNS
   * (`GenerationResult.model`) still wins on fulfilment.
   */
  readonly model: string;
  capabilities: CreativeProviderCapabilities;
  generate(_req: GenerationRequest): Promise<GenerationResult>;
  /** Instruction-following edit — conversational iteration + gate self-repair. */
  edit(_image: ImageRef, _instruction: string, _opts?: ProviderEditOptions): Promise<GenerationResult>;
  estimateCostCents(_req: Pick<GenerationRequest, 'width' | 'height' | 'quality'>): number;
}

// ── Gates & ranking ──────────────────────────────────────────────────────────

export type GateName =
  | 'policy'
  | 'prohibited_claims'
  | 'disclaimer'
  | 'lexicon'
  | 'genome_complete'
  | 'product_fidelity'
  // Deterministic copy-quality gate (2026-08-04): ungrounded numerals /
  // banned ad-speak in the persisted copy. Reports 'unverified' in v1
  // (defense-in-depth behind brand-copy's generation-time guards).
  | 'copy_grounding';

export type GateStatus = 'pass' | 'fail' | 'unverified';

/**
 * One brand judge-gate checklist verdict (brand-context Phase 6). `id` is the
 * checklist item id — `rowId@vN` for pack rules, `structural_*@r1` for the
 * fixed structural checks — so verdicts map back to exact rule versions.
 */
export interface JudgeItemVerdict {
  id: string;
  passed: boolean;
  /** Judge's short justification (always present on fails). */
  note?: string;
}

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  /** Present on fail/unverified — machine-usable reason. */
  reason?: string;
  /** True when a failed gate is fixable via one edit() self-repair attempt. */
  repairable?: boolean;
  /**
   * Brand judge-gate per-item verdicts (rides `gate: 'policy'` ONLY — one
   * policy entry per candidate; the UI keys gate badges by gate name).
   * Additive — legacy rows omit it.
   */
  items?: JudgeItemVerdict[];
  /** Judge stamp for calibration stratification. */
  judge?: { model?: string; version?: string };
}

export interface CandidateRank {
  score: number; // 0-100
  judgeVersion: string;
  rationale: string;
}

// ── Statuses ─────────────────────────────────────────────────────────────────

export type BriefStatus = 'draft' | 'queued' | 'generating' | 'completed' | 'failed';

export type CreativeStatus =
  | 'generating'
  | 'gated_out'
  | 'ranked'
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'edited'
  /** Transient publish claim — an in-flight attach-to-ad holds this so a concurrent publish 409s. */
  | 'publishing'
  | 'published'
  | 'failed';

/**
 * One RSA text asset (headline or description) with an optional pin position.
 * Mirrors the Google Ads `responsive_search_ad.{headlines,descriptions}` wire
 * shape (`{ text, pinnedField? }`).
 */
export interface RsaTextAsset {
  text: string;
  /** e.g. HEADLINE_1..HEADLINE_3 / DESCRIPTION_1..DESCRIPTION_2. Absent = unpinned. */
  pinnedField?: string;
}

/**
 * Structured copy for a copy-only (Google RSA) candidate — persisted in
 * `generated_creatives.structured_copy`. Image candidates leave this null and
 * carry `asset_url` instead; RSA copy candidates are the inverse (asset_url
 * null, structured_copy present). The joined text also lives in `copy_text`
 * (gate/rank/preview input).
 */
export interface RsaStructuredCopy {
  kind: 'rsa';
  headlines: RsaTextAsset[];
  descriptions: RsaTextAsset[];
  path1?: string;
  path2?: string;
}

/**
 * Run-wide composed copy for a brand-mode IMAGE candidate (brand-context
 * Phase 5). One copy per run rides every candidate row; `brief_fallback` =
 * the LLM copywriter failed and the brief's own headline/primaryText/cta were
 * used verbatim (never fails the run). Also the resume-determinism seed: a
 * resumed run reuses the first persisted composed copy instead of re-calling
 * the LLM.
 */
export interface ComposedStructuredCopy {
  kind: 'composed';
  /** <= 60 chars. */
  headline: string;
  /** <= 500 chars. */
  primaryText: string;
  /** <= 30 chars. */
  cta: string;
  source: 'llm' | 'brief_fallback';
  /**
   * Strategy group this copy set was written for (per-group copy, 2026-08).
   * Seed-reuse on resume matches by this key; absent = the run-wide single
   * copy (pre-strategy briefs).
   */
  strategyKey?: string;
  /**
   * Image direction written by the copywriter alongside this set (2026-09-22):
   * one camera-only scene that makes the headline's claim visible. It drives
   * the candidate's brand-mode image prompt and is NOT an ad field (publish,
   * the judges and the copy guards never read it). Persisted so a resumed run
   * reuses it for its remaining candidates. Absent = no usable concept (the
   * guard dropped it, the model omitted it, or the set is a brief fallback).
   */
  visualConcept?: string;
}

/** Any structured-copy shape a candidate can carry. */
export type StructuredCopy = RsaStructuredCopy | ComposedStructuredCopy;

/**
 * Publish provenance persisted on the candidate row (`publish_info`).
 * `published_ad_id` is the Phase 4 join key from realized ad performance
 * back to this candidate's genome. Meta and Google differ in their identity
 * fields — the shared invariant is `platform`, `adId`, `adStatus`, `actorType`
 * (service-fetchers read `publish_info?.platform ?? 'meta'`).
 */
export interface MetaCandidatePublishInfo {
  platform: 'meta';
  adAccountId: string;
  adsetId: string;
  pageId: string;
  imageHash: string;
  creativeId: string;
  adId: string;
  link: string;
  adName: string;
  /** Ads are always created PAUSED — activation stays in Ads Manager. */
  adStatus: 'PAUSED';
  actorType: string;
  /**
   * Meta replace (`publish/replace-target.ts`): the old ad this publish
   * replaced in the SAME ad set — verified server-side against the ad account
   * and ad set before anything was created.
   */
  replacedAdId?: string;
  /** The human's choice for the old ad: 'pause' (best-effort, after the create) or 'keep'. */
  replaceAdAction?: ReplaceAdAction;
  /**
   * True when the old ad is CONFIGURED off: the pause succeeded, or Meta refused it
   * and the ad was already PAUSED / ARCHIVED. Never true for a DISAPPROVED ad (it
   * resumes on re-approval) — that is a replacePauseFailed.
   */
  replacePaused?: boolean;
  /** True when 'pause' was requested and failed: the new ad exists, the old ad kept its previous state. */
  replacePauseFailed?: boolean;
}

/** Google RSA publish provenance — the copy-only sibling of the Meta shape. */
export interface GoogleCandidatePublishInfo {
  platform: 'google';
  adAccountId: string;
  /** Ad group the RSA was created in (Google's "adset" analogue). */
  adGroupId: string;
  /** `customers/{cid}/adGroupAds/{adGroupId}~{adId}` — the created ad resource. */
  adResourceName: string;
  /** Numeric Google ad id (parsed from adResourceName) — the ad_daily_metrics join key. */
  adId: string;
  finalUrl: string;
  adName: string;
  /** Ads are always created PAUSED — activation stays in Ads Manager. */
  adStatus: 'PAUSED';
  actorType: string;
  /** When this publish replaced an existing RSA, the resource name of the old ad. */
  replacedAdResourceName?: string;
  /** True when the old-ad pause failed post-create (new ad live, old ad still enabled). */
  replacePauseFailed?: boolean;
}

export type CandidatePublishInfo =
  | MetaCandidatePublishInfo
  | GoogleCandidatePublishInfo;

export interface StructuredError {
  code: string;
  reason: string;
  remediation: string;
}

/** One edit-instruction step in a creative's lineage (self-repair or human iterate). */
export interface EditLineageStep {
  instruction: string;
  actor: 'self_repair' | 'human' | 'agent';
  at: string; // ISO timestamp
  regated: boolean;
}

// ── Run orchestration ────────────────────────────────────────────────────────

export interface GenerationRunOptions {
  /** Wide-generation candidate count (env CREATIVE_GEN_WIDE_COUNT, default 4 — clamped). */
  candidateCount?: number;
  /** Top-k proposed after ranking (default 5). */
  proposeCount?: number;
}

export interface GenerationRunSummary {
  runId: string;
  briefId: string;
  organizationId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** True when a user cancel was requested but the processor has not yet honored it. */
  cancelRequested?: boolean;
  /** SUCCESSFULLY generated candidates (failed provider attempts excluded). */
  generated: number;
  gatedOut: number;
  selfRepaired: number;
  proposed: number;
  /** Provider attempts that failed to generate (additive; honest counterpart to `generated`). */
  failed?: number;
  estimatedCostCents: number;
  actualCostCents: number;
  /** Generation-profile id the run resolved (`lib/creative-engine/profiles`; additive). */
  generationProfile?: string;
  error?: StructuredError;
}

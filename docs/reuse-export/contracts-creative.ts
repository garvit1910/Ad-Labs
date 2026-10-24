/**
 * Adcero reuse export — creative-engine contracts (standalone, no imports).
 *
 * Source commit: f9bb088c93f40f1c2ae41886ba4a21b7556e102f
 * Types marked "(verbatim)" are copied from the named Adcero file with doc
 * comments trimmed. Types marked "(new)" are the text-only / joint-bandit
 * contracts this export proposes; they do not exist in Adcero.
 * Companion to reuse-export/contracts.ts (brand context, competitor ads, pages).
 */

/* ════════════════════════════════════════════════════════════════════════
 * 1. Closed enums (verbatim, services/ad-library/label-taxonomy.ts v3 and
 *    lib/creative-engine/generation/brand-copy.ts)
 * ════════════════════════════════════════════════════════════════════════ */

export const ANGLES = [
  'pain_relief',
  'convenience',
  'price_value',
  'status',
  'health',
  'time_saving',
  'trust_safety',
  'other',
] as const;

export const HOOK_ARCHETYPES = [
  'problem_callout',
  'bold_claim',
  'question',
  'social_proof',
  'curiosity',
  'offer_led',
  'demo',
  'testimonial',
  'comparison',
  'story_narrative',
  'statistic',
  'pov_relatable',
  'other',
] as const;

export const FORMATS = [
  'ugc',
  'studio',
  'text_overlay_static',
  'meme',
  'founder_talking',
  'product_demo',
  'before_after',
  'carousel_listicle',
  'testimonial_review',
  'social_screenshot',
  'us_vs_them',
  'press_advertorial',
  'tutorial_howto',
  'unboxing',
  'lifestyle_static',
  'product_only_static',
  'carousel_product_set',
  'other',
] as const;

export const PERSONAS = [
  'parents_family',
  'young_adults',
  'professionals',
  'midlife_adults',
  'seniors',
  'general_broad',
  'other',
] as const;

export const VISUAL_STYLES = [
  'lo_fi_ugc',
  'polished_studio',
  'designed_graphic',
  'screen_capture',
  'cinematic',
  'meme_style',
  'other',
] as const;

/** The only CTA labels generateBrandCopy accepts (1:1 with the publishable Meta enum). */
export const PLATFORM_CTA_LABELS = [
  'Shop Now',
  'Learn More',
  'Sign Up',
  'Subscribe',
  'Get Offer',
  'Contact Us',
  'Download',
  'Order Now',
] as const;

/**
 * Producibility today (generation/producibility.ts). `adaptable` hooks need a pack
 * fact (statistic → numeric fact, social_proof → proof_point/voc_praise,
 * testimonial → persona verbatims, offer_led → offer wording). A text-only sim can
 * relax the IMAGE-only exclusions (video, carousel, on-image text) by editing
 * those tables — see CREATIVE_MANIFEST.md Area 6.
 */
export const PRODUCIBLE_HOOKS = ['problem_callout', 'bold_claim', 'question', 'curiosity', 'pov_relatable'] as const;
export const ADAPTABLE_HOOKS = ['statistic', 'social_proof', 'testimonial', 'offer_led', 'story_narrative'] as const;
export const PRODUCIBLE_FORMATS = ['product_only_static', 'lifestyle_static', 'studio'] as const;
export const ADAPTABLE_FORMATS = ['ugc', 'unboxing'] as const;

export type Angle = (typeof ANGLES)[number];
export type HookArchetype = (typeof HOOK_ARCHETYPES)[number];
export type AdFormat = (typeof FORMATS)[number];
export type Persona = (typeof PERSONAS)[number];
export type VisualStyle = (typeof VISUAL_STYLES)[number];
export type PlatformCtaLabel = (typeof PLATFORM_CTA_LABELS)[number];

/* ════════════════════════════════════════════════════════════════════════
 * 2. Context pack (verbatim, lib/creative-engine/brand-context/types.ts)
 *    COMPILER_VERSION = 4, RENDERER_VERSIONS = { copy: 3, image: 5, judge: 4 }
 * ════════════════════════════════════════════════════════════════════════ */

export const COMPILER_VERSION = 4;
export const RENDERER_VERSIONS = { copy: 3, image: 5, judge: 4 } as const;

export type BrandContextRowType = 'fact' | 'voice' | 'rule' | 'asset' | 'persona';

export interface TagFilters {
  channels?: string[];
  products?: string[];
  audiences?: string[];
  stages?: string[];
  /** Ranking only (matched EXACTLY against spec.angleTheme), never a filter. */
  themes?: string[];
}

export interface BrandContextRow {
  rowId: string;
  rowType: BrandContextRowType;
  version: number;
  priority: number;
  tagFilters: TagFilters;
  content: Record<string, unknown>;
}

export interface CompileSpec {
  platform: 'meta' | 'google' | 'tiktok';
  aspectRatio: string;
  goal: string;
  /** `rowId@vN` (pinned) or bare rowId (latest). Exactly one persona per pack. */
  personaRef: string;
  /** The brief's angle text (=== genome.angle). One brief = one angle. */
  angle: string;
  candidates: number;
  product?: string;
  keyMessageRef?: string;
  overrides?: { audience?: string };
  angleTheme?: string;
  lessonRefs?: string[];
}

export interface RowRef {
  id: string;
  version: number;
}

export interface SlotEntry {
  id: string;
  version: number;
  content: Record<string, unknown>;
}

export interface PackSlots {
  /** ≤ 3 brand facts (+ ≤ 1 lesson appended). */
  facts: SlotEntry[];
  /** ≤ 2. */
  voice: SlotEntry[];
  /** All rules. */
  rules: SlotEntry[];
  /** ≤ 4 (logo, color_palette, font_pair, product_image). */
  assets: SlotEntry[];
  persona: SlotEntry;
}

export interface BrandContextPack {
  meta: {
    compilerVersion: number;
    rendererVersions: { copy: number; image: number; judge: number };
    brandProfileId: string;
    spec: CompileSpec;
    rowRefs: RowRef[];
  };
  slots: PackSlots;
}

/** fingerprint = sha256 hex (64 chars) of RFC-8785-style canonical JSON of the whole pack. */
export interface CompileResult {
  pack: BrandContextPack;
  fingerprint: string;
}

/** renderers/copy.ts renderCopyPrompt(pack) (verbatim). */
export interface CopyRender {
  system: string;
  user: string;
}

/** renderers/judge.ts (verbatim). */
export interface JudgeChecklistItem {
  id: string;
  source: 'rule' | 'structural';
  requirement: string;
  enforced: boolean;
}

/* ════════════════════════════════════════════════════════════════════════
 * 3. Brief + genome (verbatim, lib/creative-engine/generation/types.ts,
 *    genome-completeness.ts)
 * ════════════════════════════════════════════════════════════════════════ */

export type CreativePlatform = 'meta' | 'tiktok' | 'google';
export type AspectRatio = '1:1' | '4:5' | '9:16' | '16:9';
export type BriefSource = 'strategy_concept' | 'manual' | 'agent';

export interface BriefCompliance {
  prohibitedClaims: string[];
  requiredDisclaimers: string[];
  industry?: string;
}

export interface CreativeBrandKit {
  logoUrl?: string;
  colors?: { primary?: string; secondary?: string; accent?: string };
  fonts?: { heading?: string; body?: string };
  productImages: Array<{ id: string; url: string; fileName?: string }>;
}

export interface CreativeBrief {
  briefId: string;
  organizationId: string;
  source: BriefSource;
  conceptId?: string;
  /** Free prose. For strategy-driven briefs: deterministicAngleDirective(angle_universal). */
  angle: string;
  persona: string;
  awarenessStage?: string;
  coreMessage: string;
  hooks: string[];
  headline?: string;
  primaryText?: string;
  cta: string;
  visualDirection: string;
  style: VisualStyle;
  styleDirection?: string;
  angleUniversal?: Angle;
  personaUniversal?: Persona;
  proofFactIds?: string[];
  platform: CreativePlatform;
  aspectRatios: AspectRatio[];
  compliance: BriefCompliance;
  brandLexicon?: { avoid: string[] };
  brandKit: CreativeBrandKit;
}

export type GenomeCanonicalDimension = 'angleUniversal' | 'hookArchetype' | 'format' | 'personaUniversal';
export type GenomeProvenanceMarker = 'strategy' | 'brief' | 'prose' | 'unresolved' | 'unmapped';
export type GenomeProvenance = Record<GenomeCanonicalDimension, GenomeProvenanceMarker>;

/**
 * REQUIRED at the genome gate (REQUIRED_GENOME_FIELDS): briefId, angle, persona,
 * style, provider, model. angleUniversal / personaUniversal are type-required but
 * floored to 'other'; hookArchetype / format are absent when unresolved.
 * Outside NODE_ENV=production, buildGenome THROWS when a canonical dimension
 * floors to 'other' (GENOME_DIMENSION_UNRESOLVABLE) — see the manifest.
 */
export interface CreativeGenome {
  briefId: string;
  conceptId?: string;
  brandFactIds: string[];
  /** Free prose, never rewritten — the concept attribution key. */
  angle: string;
  persona: string;
  /** Closed enum — the accounting key (canonicalAngleUniversal). */
  angleUniversal: Angle;
  personaUniversal: Persona;
  genomeProvenance?: GenomeProvenance;
  hookArchetype?: string;
  format?: AdFormat;
  style: string;
  provider: string;
  model: string;
  generationParams: Record<string, unknown>;
  textOverlay?: boolean;
  rankScore?: number;
  judgeVersion?: string;
}

/* ════════════════════════════════════════════════════════════════════════
 * 4. Strategy (verbatim, generation/strategy.ts, pipeline-stages.ts)
 * ════════════════════════════════════════════════════════════════════════ */

export type StrategySignalSource =
  | 'own_genome'
  | 'own_label'
  | 'market_prior'
  | 'industry_benchmark'
  | 'own_belief'
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
  weight: number;
  source: StrategySignalSource;
  evidence?: { share?: number; conceptCount?: number; roas?: number | null; note?: string };
}

export interface StrategyGroup {
  /** `${hookArchetype}__${format}` — unique within a brief. */
  key: string;
  hookArchetype: HookArchetype;
  hookDirective: string;
  format: AdFormat;
  sceneDirective: string;
  visualStyle: VisualStyle;
  executionDirective?: string;
  executionNotes?: string;
}

export interface StrategyPackHints {
  hasNumericFact: boolean;
  hasSocialProofFact: boolean;
  hasCustomerVerbatim: boolean;
  hasOfferFact: boolean;
}

export type GenerationMode = 'iterate' | 'experiment';

export interface ExperimentSelection {
  kind: 'untested_angle' | 'open_territory';
  angleKey: string;
  format?: string;
  sourceKind: 'alignment_gap' | 'territory_open' | 'strategy_alternate';
}

export interface SelectStrategyInput {
  signals: StrategySignal[];
  goal: string;
  platform: string;
  explicitAngle?: string;
  packHints: StrategyPackHints;
  maxGroups?: number;
  mode?: GenerationMode;
  experimentSelection?: ExperimentSelection;
}

export interface SelectedStrategy {
  angleKey: string;
  angleDirective: string;
  groups: StrategyGroup[];
  alternates: Array<{ angleKey: string; angleDirective: string; weight: number; source: StrategySignalSource }>;
  evidence: StrategySignal[];
  fallbackTier: 'evidence' | 'goal_blueprint';
  selectionTier?: 'experiment_selection';
}

/** buildVariationPlan output — `text` = sceneDirective → executionDirective → notes. */
export interface VariationSpec {
  key: string;
  text: string;
  hookArchetype?: string;
  format?: string;
  strategyKey?: string;
  execution?: { directive: boolean; notes: boolean };
}

/* ════════════════════════════════════════════════════════════════════════
 * 5. Joint-arm bandit (new)
 * ════════════════════════════════════════════════════════════════════════ */

/** `${angle_universal}|${hook_archetype}` — the performance dimension value of arm cells. */
export type JointArmKey = `${Exclude<Angle, 'other'>}|${Exclude<HookArchetype, 'other'>}`;

/** Dimension name the joint cells use when fed through Adcero's rollup/belief code. */
export const JOINT_ARM_DIMENSION = 'angle_hook';

/** One chosen arm for one segment (segment = the pack's persona row id). */
export interface ChosenArm {
  segment: string;
  angleUniversal: Exclude<Angle, 'other'>;
  hookArchetype: Exclude<HookArchetype, 'other'>;
  /** Optional; else filled by rankedProducibleFormats(signals). */
  format?: AdFormat;
}

/** strategyFromArms(arms, input): every arm in one call must share ONE angle. */
export type StrategyFromArms = (arms: ChosenArm[], input: SelectStrategyInput) => SelectedStrategy;

/* ════════════════════════════════════════════════════════════════════════
 * 6. Copy, gates, judge, rank (verbatim, generation/brand-copy.ts, types.ts)
 * ════════════════════════════════════════════════════════════════════════ */

export interface BrandCopySet {
  /** ≤ 60 chars (truncated). */
  headline: string;
  /** ≤ 500 chars (truncated). */
  primaryText: string;
  /** One of PLATFORM_CTA_LABELS. */
  cta: string;
  /** ≤ 300 chars; dropped (undefined) when it contains any digit or a double quote. */
  visualConcept?: string;
}

export interface BrandCopyResult {
  copy: BrandCopySet;
  source: 'llm' | 'brief_fallback';
  strategyKey?: string;
  error?: { code: string; reason: string };
}

export interface ComposedStructuredCopy {
  kind: 'composed';
  headline: string;
  primaryText: string;
  cta: string;
  source: 'llm' | 'brief_fallback';
  strategyKey?: string;
  visualConcept?: string;
}

export type GateName =
  | 'policy'
  | 'prohibited_claims'
  | 'disclaimer'
  | 'lexicon'
  | 'genome_complete'
  | 'product_fidelity'
  | 'copy_grounding';

export type GateStatus = 'pass' | 'fail' | 'unverified';

/** One judge checklist item's verdict (judge-gate-v3 strict json_schema item). */
export interface JudgeItemVerdict {
  id: string;
  passed: boolean;
  note?: string;
}

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  reason?: string;
  repairable?: boolean;
  items?: JudgeItemVerdict[];
  judge?: { model?: string; version?: string };
}

/** The judge gate's full verdict for one creative (shape of the strict json_schema reply). */
export interface JudgeVerdict {
  version: 'judge-gate-v3';
  model: string;
  mode: 'off' | 'shadow' | 'enforce_structural' | 'enforce';
  items: JudgeItemVerdict[];
}

export interface CandidateRank {
  /** 0–100. */
  score: number;
  judgeVersion: 'llm-judge-v1' | 'llm-judge-v2-multimodal' | 'heuristic-v1' | (string & {});
  rationale: string;
}

/* ════════════════════════════════════════════════════════════════════════
 * 7. The text-only creative (new) — what the simulator consumes
 * ════════════════════════════════════════════════════════════════════════ */

export interface TextCreative {
  id: string;
  briefId: string;
  segment: string;
  arm: { angleUniversal: Exclude<Angle, 'other'>; hookArchetype: HookArchetype; key: JointArmKey | string };
  format: AdFormat;
  headline: string;
  primaryText: string;
  cta: string;
  /** One line describing the intended visual. */
  visualDescription: string;
  /** visual_concept = copywriter's visualConcept; variation_text = the group's composed scene/execution text. */
  visualDescriptionSource: 'visual_concept' | 'variation_text';
  copySource: 'llm' | 'brief_fallback';
  copyError?: { code: string; reason: string };
  /** composeCopyBlock output (headline / primary / `CTA: …` / disclaimers) — what the gates scanned. */
  copyText: string;
  gateResults: GateResult[];
  rank: CandidateRank;
  genome: CreativeGenome;
  packFingerprint: string;
  status: 'ranked' | 'gated_out';
  /** The image prompt this creative WOULD have been rendered with (reference only). */
  intendedImagePrompt?: string;
}

/* ════════════════════════════════════════════════════════════════════════
 * 8. Simulation reward → rollup → beliefs (verbatim loop types + new SimReward)
 * ════════════════════════════════════════════════════════════════════════ */

/** (new) One simulated outcome for one creative. */
export interface SimReward {
  creativeId: string;
  armKey: string;
  segment: string;
  simulatedAt: string;
  impressions: number;
  clicks: number;
  conversions: number;
  source: string;
}

/** loop/types.ts (verbatim). The sim → rollup adapter emits one per creative per day. */
export interface DailyMetricInput {
  adId: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  enhancedPurchases: number | null;
  enhancedPurchaseValue: number | null;
}

export interface FatigueSignal {
  ctrRecent: number;
  ctrPrior: number;
  declining: boolean;
}

/** loop/types.ts DimensionRollup (verbatim; `dimension` widened to string for joint arms). */
export interface DimensionRollup {
  platform: string;
  source: 'genome' | 'label';
  dimension: string;
  dimensionValue: string;
  candidateCount: number;
  adCount: number;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  decayedSpend: number;
  decayedImpressions: number;
  decayedClicks: number;
  decayedPurchases: number;
  decayedPurchaseValue: number;
  enhancedPurchases: number | null;
  enhancedPurchaseValue: number | null;
  enhancedCoverage: number;
  captureRatio: number | null;
  basis: 'platform' | 'attributed';
  meanRankScore: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  fatigue: FatigueSignal | null;
}

export interface BeliefCurve {
  alpha: number;
  beta: number;
  mean: number;
  ci95: [number, number];
  source: 'pooled' | 'dimension' | 'vague';
  priorEss: number;
}

export interface CellBeliefs {
  v: 1;
  basis: 'platform';
  /** Clicks per impression. */
  click: BeliefCurve;
  /** Purchases per click. */
  purchase: BeliefCurve;
}

export interface ObjectiveEvidence {
  decayedImpressions: number;
  decayedClicks: number;
  decayedPurchases: number;
  decayedPurchaseValue: number;
}

/** loop/sampler.ts (verbatim). */
export interface Arm {
  dimension: string;
  value: string;
  beliefs: CellBeliefs;
  evidence?: ObjectiveEvidence;
}

export interface SamplerArmRecord {
  value: string;
  draw?: number;
  mean: number;
  ci95: [number, number];
  objectiveFallback?: true;
}

export interface SamplerDecision {
  strategy: 'thompson' | 'widest';
  layer: 'click' | 'purchase';
  picked: { dimension: string; value: string };
  mode: 'exploit' | 'explore';
  arms: SamplerArmRecord[];
  objective?: 'ctr' | 'cpc' | 'roas' | 'cpa';
  objectiveFallback?: 'no_arm_evidence' | 'no_pool_scale';
}

/* ════════════════════════════════════════════════════════════════════════
 * 9. Fixture envelopes (new) — fixtures/creative-brief.json + creative-output.json
 * ════════════════════════════════════════════════════════════════════════ */

export interface UpstreamFact {
  id: string;
  section: string;
  fact_key: string;
  statement: string;
  details: Record<string, unknown>;
  confidence: number;
  status: string;
}

export interface CopyRequestCapture {
  model: string;
  temperature: number;
  max_tokens: number;
  response_format: { type: 'json_object' };
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

export interface CreativeBriefEntry {
  key: string;
  chosenArms: ChosenArm[];
  packHints: StrategyPackHints;
  selectedStrategy: SelectedStrategy;
  brief: CreativeBrief;
  canonical: { value: Angle; rung: string };
  compileSpec: CompileSpec;
  pack: BrandContextPack;
  packFingerprint: string;
  versions: { compilerVersion: number; rendererVersions: { copy: number; image: number; judge: number } };
  copyPrompt: CopyRender;
  judgeChecklist: JudgeChecklistItem[];
  variationPlan: VariationSpec[];
  copyRequests: CopyRequestCapture[];
}

export interface CreativeBriefFixture {
  _meta: Record<string, unknown>;
  brandFacts: UpstreamFact[];
  brandContextRows: BrandContextRow[];
  armSpace: { pickableAngles: string[]; producibleHooks: string[]; size: number; pruned12: string[]; pruningNote: string };
  chosenArms: ChosenArm[];
  briefs: CreativeBriefEntry[];
}

export interface CreativeOutputFixture {
  _meta: Record<string, unknown>;
  creatives: TextCreative[];
  simRewards: SimReward[];
  rollups: DimensionRollup[];
  arms: Arm[];
  nextDecision: { exploit: SamplerDecision | null; explore: SamplerDecision | null; seed: number; layer: 'click' | 'purchase' };
}

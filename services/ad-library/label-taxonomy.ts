/**
 * Label taxonomy for AI ad labelling. Single source of truth for the LLM
 * JSON schema enums, payload validation, and UI filter options.
 */

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

export const OFFER_TYPES = [
  'discount',
  'free_shipping',
  'bundle',
  'trial',
  'guarantee',
  'bogo_gwp',
  'urgency_limited',
  'financing',
  'giveaway',
  'subscribe_save',
  'none',
] as const;

/**
 * Universal persona vocabulary — the broad customer group an ad speaks to,
 * stable across industries (`angle`'s persona analogue). The LLM also picks a
 * high-resolution industry-specific `persona` (see `industry-taxonomy.ts`);
 * this is the cross-industry-comparable fallback stored in
 * `ad_labels.persona_universal`.
 */
export const PERSONAS = [
  'parents_family',
  'young_adults',
  'professionals',
  'midlife_adults',
  'seniors',
  'general_broad',
  'other',
] as const;

/**
 * Where in the funnel the ad operates: `tof_problem` problem/pain awareness for
 * cold audiences, `mof_solution` solution comparison/benefits, `bof_offer`
 * offer/urgency/retargeting closers.
 */
export const FUNNEL_STAGES = ['tof_problem', 'mof_solution', 'bof_offer', 'other'] as const;

/**
 * Emotional register of the creative (fingerprint `tone` dimension) — judged
 * from the creative plus copy. All ads WITH visual context; distinct from
 * `format` (production style) and `style` (visual aesthetic).
 */
export const TONES = [
  'humorous',
  'aspirational',
  'educational',
  'fear_urgency',
  'heartfelt',
  'plain_promotional',
  'other',
] as const;

/** Coarse video-duration buckets (video ads only; derived deterministically when measurable). */
export const DURATION_BUCKETS = ['lt15', '15_30', '30_60', 'gt60'] as const;

/** Bumped whenever the taxonomy changes shape; stamped on rows via `ad_labels.tags.taxonomyVersion`. */
export const LABEL_TAXONOMY_VERSION = 3;

/**
 * Visual aesthetic of the creative (fingerprint `style` dimension). Distinct
 * from `format` (production format: who/what the creative is — ugc, founder,
 * demo...): style is how it LOOKS. Values live under the same `style`
 * dimension name the creative-engine genome / performance_memory rollup keys
 * on (the genome side is freeform prose, so the shared unit is the dimension
 * name + text value, not a shared enum).
 */
export const VISUAL_STYLES = [
  'lo_fi_ugc', // phone-shot, casual, creator-style footage
  'polished_studio', // professional shoot, controlled lighting
  'designed_graphic', // flat design / composed layout / illustration
  'screen_capture', // screen recording or app UI walkthrough
  'cinematic', // filmic color/composition, produced video
  'meme_style', // meme composition or template humor
  'other',
] as const;

/** Coarse creative aspect-ratio buckets (derived deterministically from the poster). */
export const ASPECT_RATIOS = ['9:16', '4:5', '1:1', '16:9', 'other'] as const;

/** Where the creative appears to be shot/set (fingerprint attribute). */
export const SETTINGS = [
  'home', // lived-in interior, bedroom/kitchen/bathroom
  'studio', // seamless/controlled backdrop
  'outdoor',
  'digital', // pure graphic/screen space, no physical scene
  'other',
] as const;

/** Video pacing (fingerprint attribute; video ads only). */
export const PACINGS = ['static', 'slow', 'fast'] as const;

export type HookArchetype = (typeof HOOK_ARCHETYPES)[number];
export type Angle = (typeof ANGLES)[number];
export type AdFormat = (typeof FORMATS)[number];
export type OfferType = (typeof OFFER_TYPES)[number];
export type VisualStyle = (typeof VISUAL_STYLES)[number];
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type FingerprintSetting = (typeof SETTINGS)[number];
export type Pacing = (typeof PACINGS)[number];
export type Persona = (typeof PERSONAS)[number];
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export type Tone = (typeof TONES)[number];
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

/**
 * Creative fingerprint attributes stored in `ad_labels.fingerprint` (jsonb).
 * All optional: text-only labelling can't judge visual attributes, and the
 * video-only fields are absent for images/carousels.
 */
export interface AdFingerprint {
  people_present?: boolean;
  talking_head?: boolean;
  text_overlay?: boolean;
  setting?: FingerprintSetting;
  /** Video only — whether there is narration/voiceover distinct from a person on camera. */
  voiceover?: boolean;
  /** Video only — cut/motion cadence. */
  pacing?: Pacing;
  /** Video only — what is said/shown in the first ~3 seconds, one short line. */
  spoken_hook?: string;
  /** Video only — coarse duration bucket (deterministic when measurable, else the model's estimate). */
  duration_bucket?: DurationBucket;
  /** Video only — what is ON SCREEN in the first ~3 seconds, one short line (the visual counterpart of spoken_hook). */
  visual_hook?: string;
  /** Video only — burned-in subtitles/captions present. */
  captions?: boolean;
  /** Video only — a music track is present (orthogonal to voiceover). */
  music?: boolean;
  /** All ads WITH visual context — the emotional register of the creative. */
  tone?: Tone;
  /**
   * All ads WITH visual context — 1–3 short sentences of product-agnostic
   * STAGING DIRECTION (framing, arrangement, props, lighting, environment,
   * mood) another brand could reuse. Prompted brand-name-free and sanitized
   * again at market-distillation write time; normalized (cap/trim) in
   * label/rows.ts. Taxonomy v3.
   */
  execution_notes?: string;
}

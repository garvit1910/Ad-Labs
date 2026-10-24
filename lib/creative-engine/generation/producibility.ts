/**
 * Producibility map (strategy selection, 2026-08) — which competitor-ad
 * FORMATS and HOOK_ARCHETYPES (services/ad-library/label-taxonomy.ts) the
 * creative engine can actually produce. We generate SINGLE STATIC IMAGES:
 * founder-talking videos, demos, multi-card carousels, and on-image-text
 * formats are NOT producible, so the selector falls back down the ranked
 * evidence to the next-best producible option instead of aping a winning
 * format it cannot execute (a "founder story" winner must never yield a
 * static image pretending to be one).
 *
 * PURE — no IO. Every taxonomy member has an explicit entry (exhaustiveness
 * is test-pinned); a new taxonomy value must consciously land here.
 */
import type {
  AdFormat,
  HookArchetype,
  VisualStyle,
} from '@/services/ad-library/label-taxonomy';

export type Producibility = 'producible' | 'adaptable' | 'not_producible';

/** A fact-availability requirement an adaptable hook needs from the pack. */
export type HookRequirement =
  | 'numeric_fact'
  | 'social_proof_fact'
  | 'customer_verbatim'
  | 'offer_fact';

export interface FormatEntry {
  status: Producibility;
  /**
   * Scene directive for the per-candidate image variation (adaptable formats
   * carry their static adaptation). Present on every non-not_producible entry.
   */
  sceneDirective?: string;
  /** Genome/prompt visual style this format maps onto. */
  visualStyle?: VisualStyle;
}

export const FORMAT_PRODUCIBILITY: Record<AdFormat, FormatEntry> = {
  product_only_static: {
    status: 'producible',
    sceneDirective:
      'Product hero on a clean seamless studio background, soft directional lighting, gentle shadow, label facing camera.',
    visualStyle: 'polished_studio',
  },
  lifestyle_static: {
    status: 'producible',
    sceneDirective:
      'Product in a realistic in-use scene: the exact moment a customer uses it, natural light, candid framing.',
    visualStyle: 'polished_studio',
  },
  studio: {
    status: 'producible',
    sceneDirective:
      'Editorial studio composition: the product staged with only the props that naturally accompany its use, controlled lighting.',
    visualStyle: 'polished_studio',
  },
  ugc: {
    status: 'adaptable',
    sceneDirective:
      'Candid lo-fi phone-photo still: the product held or in use in a real, lived-in setting — imperfect framing, natural light, zero studio polish.',
    visualStyle: 'lo_fi_ugc',
  },
  unboxing: {
    status: 'adaptable',
    sceneDirective:
      'Static flat-lay of the just-opened package: box open, product and contents arranged as they arrived, overhead view.',
    visualStyle: 'lo_fi_ugc',
  },
  // Video / motion formats — a static image cannot be these.
  founder_talking: { status: 'not_producible' },
  product_demo: { status: 'not_producible' },
  tutorial_howto: { status: 'not_producible' },
  // On-image-text / fabricated-UI formats — banned by the clean-image doctrine.
  text_overlay_static: { status: 'not_producible' },
  meme: { status: 'not_producible' },
  testimonial_review: { status: 'not_producible' },
  social_screenshot: { status: 'not_producible' },
  us_vs_them: { status: 'not_producible' },
  before_after: { status: 'not_producible' },
  press_advertorial: { status: 'not_producible' },
  // Multi-card formats — one image per candidate.
  carousel_listicle: { status: 'not_producible' },
  carousel_product_set: { status: 'not_producible' },
  other: { status: 'not_producible' },
};

export interface HookEntry {
  status: Producibility;
  /** Fact-availability gate — the selector checks it against the pack. */
  requires?: HookRequirement;
  /**
   * Execution directive for the copywriter (rides the brand-copy wrapper's
   * per-strategy block). Present on every non-not_producible entry.
   */
  hookDirective?: string;
  /**
   * Image-variation scene directive (2026-09-22): how this hook LOOKS in a
   * single static image. `buildGroup` composes it AFTER the format's scene
   * (format sets the shot type, hook sets the moment/content) into the
   * group's one `sceneDirective` string — without it every hook on the same
   * format rendered the same picture. Clean-image doctrine: no added text,
   * no fabricated UI, no before/after split, no comparison. Present on every
   * non-not_producible entry (test-pinned).
   */
  sceneDirective?: string;
  /**
   * People-free still-life variant of `sceneDirective`, present ONLY on the
   * PERSON_IMPLYING_HOOKS (test-pinned both ways). The same hook idea told
   * through the product, props, arrangement, or implied presence — used by
   * `buildGroup` when the group's format excludes people
   * (`FORMAT_CUE_EXCLUSIONS[format].people` includes 'true'), so a
   * people-free format never receives a person-centric moment.
   */
  stillLifeSceneDirective?: string;
}

/**
 * Hooks whose `sceneDirective` depicts (or, for problem_callout / story
 * moments, almost always renders) a PERSON — each carries a people-free
 * `stillLifeSceneDirective`. The rest are people-neutral as written and need
 * no variant: bold_claim (hero product + props), question (an unexpected
 * angle/crop of the product), curiosity (a product detail close up),
 * statistic (quantity shown through objects), offer_led (abundant product
 * staging). Adding a person to one of those scenes means adding it here.
 */
export const PERSON_IMPLYING_HOOKS: readonly HookArchetype[] = [
  'problem_callout',
  'pov_relatable',
  'social_proof',
  'testimonial',
  'story_narrative',
];

export const HOOK_PRODUCIBILITY: Record<HookArchetype, HookEntry> = {
  problem_callout: {
    status: 'producible',
    hookDirective:
      'Open on the specific pain the product removes — name the moment the customer feels it, then resolve it with a brand fact.',
    sceneDirective:
      'Capture the exact moment of the everyday frustration this product removes, with the product visibly present as the fix — the tension resolving in one frame.',
    stillLifeSceneDirective:
      "A still life of the frustration's aftermath — the telltale props or mess the product removes — with the product placed beside them as the clear fix; no people.",
  },
  bold_claim: {
    status: 'producible',
    hookDirective:
      'Lead with the single strongest fact-backed claim, stated plainly and concretely — no superlatives the facts cannot carry.',
    sceneDirective:
      'A confident, hero-scale product composition that makes its single strongest benefit tangible through real ingredients, materials, or props — the image itself carries the claim.',
  },
  question: {
    status: 'producible',
    hookDirective:
      'Open with a sharp question the persona actually asks themselves; the copy answers it with a brand fact.',
    sceneDirective:
      'An intriguing composition that poses a visual question — an unexpected angle, placement, or crop of the product that makes the viewer look twice to work it out.',
  },
  curiosity: {
    status: 'producible',
    hookDirective:
      'Open with a specific, surprising detail from the brand facts that makes the reader need the explanation.',
    sceneDirective:
      'Build the frame around one surprising, specific visual detail of the product — a texture, ingredient, mechanism, or scale — shown close enough to spark curiosity.',
  },
  pov_relatable: {
    status: 'producible',
    hookDirective:
      "Write from the persona's own point of view — a first-person moment they recognize, resolved by the product.",
    sceneDirective:
      "A first-person or over-the-shoulder perspective of the persona's own everyday moment with the product, framed exactly as they would see it themselves.",
    stillLifeSceneDirective:
      "The persona's own vantage over their table, desk, or counter with the product in their everyday spot, framed as they would see it — no person visible.",
  },
  statistic: {
    status: 'adaptable',
    requires: 'numeric_fact',
    hookDirective:
      'Lead with the exact number a brand fact states (never rounded, never invented) and make it tangible.',
    sceneDirective:
      "Make the brand fact's number physically tangible — quantity, volume, or scale shown through real objects arranged with the product; never render digits, charts, or text.",
  },
  social_proof: {
    status: 'adaptable',
    requires: 'social_proof_fact',
    hookDirective:
      'Lead with the proof point a brand fact provides (reviews, customers, ratings) — exactly as the fact states it.',
    sceneDirective:
      "A real customer's genuine, unposed moment enjoying the product — natural and candid, with no review stars, ratings, badges, or quoted text anywhere in the frame.",
    stillLifeSceneDirective:
      'Evidence of genuine, repeated use — a well-loved, half-finished product in a real setting where it clearly belongs; no people, stars, ratings, or text.',
  },
  testimonial: {
    status: 'adaptable',
    requires: 'customer_verbatim',
    hookDirective:
      "Build the copy around a real customer verbatim from the persona section — quoted or closely paraphrased, never invented.",
    sceneDirective:
      'One real customer in a genuine, candid moment with the product, as if the photo accompanied their own words — no quotes, stars, captions, or text in the frame.',
    stillLifeSceneDirective:
      'A well-used product in the real spot a customer keeps it, showing signs of genuine daily use — no people, quotes, stars, captions, or text.',
  },
  offer_led: {
    status: 'adaptable',
    requires: 'offer_fact',
    hookDirective:
      'Lead with the concrete offer a brand fact establishes — never invent a discount, trial, or guarantee.',
    sceneDirective:
      'The product presented as the reward — generous, abundant staging that feels like getting more; never render a price, discount, badge, or any text.',
  },
  story_narrative: {
    status: 'adaptable',
    hookDirective:
      'Tell one compact, specific customer moment (beginning → product → after) grounded in the persona pains and brand facts.',
    sceneDirective:
      'One frozen mid-story moment in a single frame — the instant the product enters the scene and changes it — so the viewer senses what came before and after.',
    stillLifeSceneDirective:
      'A single still-life frame that implies before and after through objects — what the product replaced set beside it in use; no people.',
  },
  // Inherently motion / compliance-risky.
  demo: { status: 'not_producible' },
  comparison: { status: 'not_producible' },
  other: { status: 'not_producible' },
};

export function isProducibleFormat(format: AdFormat): boolean {
  return FORMAT_PRODUCIBILITY[format].status !== 'not_producible';
}

export function isProducibleHook(hook: HookArchetype): boolean {
  return HOOK_PRODUCIBILITY[hook].status !== 'not_producible';
}

/**
 * Walk a ranked list of taxonomy values and keep the producible ones, in
 * order — the "founder talking → fall back to the next best angle" rule.
 */
export function filterProducible<T extends string>(
  ranked: T[],
  isProducible: (_value: T) => boolean
): T[] {
  return ranked.filter((value) => isProducible(value));
}

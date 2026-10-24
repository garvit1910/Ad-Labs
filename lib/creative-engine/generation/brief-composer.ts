/**
 * Interim brief composer (human form / agent `compose_brief`).
 *
 * Deterministic — NO LLM in v1: a goal-strategy table × a platform-strategy
 * table derive angle/persona/coreMessage/hooks/visualDirection/style/cta from
 * the inputs. Brand context (`brandSummary`, `brandAssets`) is PASSED IN by
 * the caller — this module never reads the DB. Phase 2 replaces this as the
 * primary brief producer via a `conceptToBrief` adapter; the composer stays as
 * the manual/agent ad-hoc path (human-first principle).
 */

import type {
  AspectRatio,
  BrandColors,
  BrandFonts,
  BrandKitProductImage,
  BriefCompliance,
  BriefSource,
  CreativeBrief,
  CreativePlatform,
  VisualStyle,
} from './types';
import { VISUAL_STYLES } from '@/services/ad-library/label-taxonomy';
import type { PerformancePriors } from '../loop/types';
import type { SelectedStrategy } from './strategy';

type CreativeGoal = 'awareness' | 'conversions' | 'engagement' | 'traffic';

interface GoalStrategy {
  angle: string;
  visualDirection: string;
  /** Closed visual-style bucket stamped on the genome (hardcoded per blueprint). */
  style: VisualStyle;
  /** Rich art-direction prose woven into the image prompt. */
  styleDirection: string;
  cta: string;
  hookTemplates: string[];
}

/** Goal-strategy text table (adapted fresh from the old creative-studio guidance). */
const GOAL_STRATEGIES: Record<CreativeGoal, GoalStrategy> = {
  awareness: {
    angle: 'Introduce the brand with a memorable, identity-forward first impression',
    visualDirection:
      'Bold, instantly recognizable brand-led imagery that lands the name and category in under two seconds',
    style: 'designed_graphic',
    styleDirection: 'high-contrast, iconic, brand-saturated',
    cta: 'Learn More',
    hookTemplates: [
      'Meet {brand}',
      'The new name in {category}',
      "You haven't seen {category} like this",
    ],
  },
  conversions: {
    angle: 'Drive immediate action with concrete value and a clear offer',
    visualDirection:
      'Product-hero composition with a clear offer treatment and an unmissable call-to-action zone',
    style: 'polished_studio',
    styleDirection: 'clean, product-forward, offer-led',
    cta: 'Shop Now',
    hookTemplates: [
      '{message} — starting today',
      'The {category} pick that pays for itself',
      'Why thousands choose {brand}',
    ],
  },
  engagement: {
    angle: 'Spark a reaction with a relatable, conversation-starting moment',
    visualDirection:
      'Human, candid, story-first imagery that invites a comment or share rather than a hard sell',
    style: 'lo_fi_ugc',
    styleDirection: 'warm, authentic, personality-led',
    cta: 'Learn More',
    hookTemplates: [
      'Tell us: {message}?',
      'The {category} take nobody says out loud',
      '{brand} gets it',
    ],
  },
  traffic: {
    angle: 'Create curiosity that only a click resolves',
    visualDirection:
      'Clean editorial framing with one intriguing focal element and breathing room for the headline',
    style: 'designed_graphic',
    styleDirection: 'crisp, editorial, curiosity-driven',
    cta: 'Learn More',
    hookTemplates: [
      'See how {brand} does {category} differently',
      'The full story behind {message}',
      '3 things to know before buying {category}',
    ],
  },
};

/** Platform native-format guidance appended to the visual direction. */
const PLATFORM_STRATEGIES: Record<CreativePlatform, string> = {
  meta: 'Native feed look: thumb-stopping first impression, minimal overlay text, mobile-first framing that holds up at 1:1 and 4:5',
  tiktok:
    'UGC-native vertical energy: handheld authenticity, real-scene texture, a pattern interrupt in the first beat, built for 9:16',
  google:
    'Display-network clarity: strong product focus, high legibility at small sizes, uncluttered background, no fine print in-image',
};

export interface ComposeBriefBrandSummary {
  brandName?: string;
  brandVoice?: string;
  productsOrServices?: string;
  targetAudience?: string;
  valuePropositions?: string[];
  keyMessages?: string[];
  competitiveAdvantages?: string[];
  industryCategory?: string;
}

export interface ComposeBriefBrandAssets {
  logoUrl?: string;
  colors?: BrandColors;
  fonts?: BrandFonts;
  productImages?: BrandKitProductImage[];
}

export interface ComposeBriefInput {
  organizationId: string;
  brandSummary?: ComposeBriefBrandSummary;
  brandAssets?: ComposeBriefBrandAssets;
  goal: string;
  platform: CreativePlatform;
  aspectRatios: AspectRatio[];
  audience?: string;
  keyMessage?: string;
  competitiveAngle?: string;
  /** Merged over the default {prohibitedClaims:[], requiredDisclaimers:[]}. */
  compliance?: Partial<BriefCompliance>;
  source?: BriefSource;
  /**
   * Phase 4 "what's working" priors (from `performance_memory`). Only fills
   * the angle DEFAULT — an explicit `competitiveAngle` always wins. The prior
   * angle is used VERBATIM (never rephrased): the genome's angle string is the
   * concept-attribution key, so a reworded angle would fork the dimension
   * value and break performance accumulation.
   */
  performancePriors?: PerformancePriors;
  /**
   * Evidence-driven strategy (competitor market priors + own priors run
   * through selectStrategy). Its angleDirective already folds the explicit
   * angle and the own-genome prior (verbatim — attribution-safe), so it sits
   * right after the explicit input on the angle ladder; its groups replace
   * the goal-blueprint hook templates.
   */
  selectedStrategy?: SelectedStrategy;
}

/** Whether composeBrief would source its angle from the performance prior. */
export function wouldApplyAnglePrior(input: {
  competitiveAngle?: string;
  performancePriors?: PerformancePriors;
}): boolean {
  return !input.competitiveAngle?.trim() && Boolean(input.performancePriors?.topAngle?.value);
}

const VISUAL_STYLE_SET = new Set<string>(VISUAL_STYLES);

/**
 * A `topStyle` prior is only usable as the genome `style` when its rollup value
 * is a valid `VISUAL_STYLES` member. Old prose-valued rollup rows survive until
 * the backfill + re-rollup lands — applying a prose prior would re-introduce an
 * off-taxonomy genome value, so those are ignored (fall through to blueprint).
 */
function priorStyleIfEnum(
  performancePriors?: PerformancePriors
): VisualStyle | undefined {
  const value = performancePriors?.topStyle?.value;
  return value && VISUAL_STYLE_SET.has(value) ? (value as VisualStyle) : undefined;
}

function normalizeGoal(goal: string): CreativeGoal {
  const normalized = goal.trim().toLowerCase();
  if (normalized in GOAL_STRATEGIES) return normalized as CreativeGoal;
  // Sensible DTC default for unrecognized goals.
  return 'conversions';
}

function fillTemplate(
  template: string,
  values: { brand: string; category: string; message: string }
): string {
  return template
    .replaceAll('{brand}', values.brand)
    .replaceAll('{category}', values.category)
    .replaceAll('{message}', values.message);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Deterministically compose a brief from caller-supplied brand context + intent. */
export function composeBrief(input: ComposeBriefInput): Omit<CreativeBrief, 'briefId'> {
  const goal = normalizeGoal(input.goal);
  const goalStrategy = GOAL_STRATEGIES[goal];
  const platformStrategy = PLATFORM_STRATEGIES[input.platform];
  const summary = input.brandSummary ?? {};

  const brand = summary.brandName?.trim() || 'the brand';
  const category =
    summary.industryCategory?.trim() || summary.productsOrServices?.trim() || 'products';

  const coreMessage =
    input.keyMessage?.trim() ||
    summary.valuePropositions?.[0]?.trim() ||
    summary.keyMessages?.[0]?.trim() ||
    `Why ${brand} is the better choice for ${category}`;

  const persona =
    input.audience?.trim() ||
    summary.targetAudience?.trim() ||
    `People shopping for ${category}`;

  // Angle priority: explicit input > evidence-driven strategy (which itself
  // folds the own-genome prior verbatim) > realized-performance prior >
  // brand summary edge > goal default.
  const strategyAngle =
    input.selectedStrategy?.fallbackTier === 'evidence' &&
    input.selectedStrategy.angleDirective
      ? input.selectedStrategy.angleDirective
      : undefined;
  const angle =
    input.competitiveAngle?.trim() ||
    strategyAngle ||
    input.performancePriors?.topAngle?.value ||
    (summary.competitiveAdvantages?.[0]
      ? `Lead with the edge: ${summary.competitiveAdvantages[0]}`
      : goalStrategy.angle);

  const templateValues = { brand, category, message: coreMessage };
  // Strategy groups carry real hook execution directives — the goal-blueprint
  // templates are the no-evidence fallback only.
  // LEGACY-MODE-REMOVAL: GOAL_STRATEGIES demotes further as strategy coverage grows.
  const strategyHooks = (input.selectedStrategy?.groups ?? [])
    .map((group) => group.hookDirective)
    .filter((directive) => directive.length > 0);
  const hooks =
    strategyHooks.length > 0
      ? strategyHooks
      : goalStrategy.hookTemplates.map((template) =>
          fillTemplate(template, templateValues)
        );

  const colors = input.brandAssets?.colors;
  const paletteHint = colors?.primary
    ? ` Use the brand palette (primary ${colors.primary}${colors.secondary ? `, secondary ${colors.secondary}` : ''}${colors.accent ? `, accent ${colors.accent}` : ''}).`
    : '';
  const visualDirection = `${goalStrategy.visualDirection}. ${platformStrategy}.${paletteHint}`;

  // Rich art direction (prose) — byte-identical to the previously-composed
  // `style` string so image prompts do not regress: blueprint prose + optional
  // brand-voice tone.
  const styleDirection = summary.brandVoice?.trim()
    ? `${goalStrategy.styleDirection}, ${summary.brandVoice.trim()} tone`
    : goalStrategy.styleDirection;

  // Style-bucket priority (mirrors the angle-prior rule): the realized-
  // performance top style (stronger evidence than a static default) wins over
  // the goal blueprint — but ONLY when the prior value is a valid enum member
  // (a prose rollup row from before the backfill is ignored). No explicit
  // style-override input exists on ComposeBriefInput today.
  const style: VisualStyle =
    priorStyleIfEnum(input.performancePriors) ??
    input.selectedStrategy?.groups[0]?.visualStyle ??
    goalStrategy.style;

  const supportingProps = (summary.valuePropositions ?? [])
    .slice(0, 2)
    .map((prop) => prop.trim())
    .filter((prop) => prop.length > 0 && prop !== coreMessage);
  const primaryText = [coreMessage, ...supportingProps]
    .map((sentence) => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`))
    .join(' ');

  return {
    organizationId: input.organizationId,
    source: input.source ?? 'manual',
    angle,
    persona,
    coreMessage,
    hooks,
    headline: truncate(coreMessage, 60),
    primaryText,
    cta: goalStrategy.cta,
    visualDirection,
    style,
    styleDirection,
    proofFactIds: [],
    platform: input.platform,
    aspectRatios: input.aspectRatios,
    compliance: {
      prohibitedClaims: input.compliance?.prohibitedClaims ?? [],
      requiredDisclaimers: input.compliance?.requiredDisclaimers ?? [],
      ...(input.compliance?.industry ? { industry: input.compliance.industry } : {}),
    },
    brandKit: {
      ...(input.brandAssets?.logoUrl ? { logoUrl: input.brandAssets.logoUrl } : {}),
      ...(input.brandAssets?.colors ? { colors: input.brandAssets.colors } : {}),
      ...(input.brandAssets?.fonts ? { fonts: input.brandAssets.fonts } : {}),
      productImages: input.brandAssets?.productImages ?? [],
    },
  };
}

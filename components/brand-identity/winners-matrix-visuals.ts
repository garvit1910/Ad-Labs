/**
 * Visual registry for the "Winners vs the rest" matrix: per-taxonomy-value
 * icon + accent colour, the deterministic fallback palette, and the quadrant
 * metadata. Pure data + lookup - the model math lives in winners-matrix.ts.
 */

import {
  AlertTriangle,
  BadgePercent,
  Ban,
  Camera,
  Clock,
  Crown,
  Film,
  FlaskConical,
  Gauge,
  Gift,
  GitCompare,
  GraduationCap,
  HeartPulse,
  HelpCircle,
  Home,
  Hourglass,
  Images,
  Laugh,
  LayoutGrid,
  Leaf,
  type LucideIcon,
  Megaphone,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Newspaper,
  Package,
  PackageOpen,
  Pause,
  Percent,
  Quote,
  RectangleVertical,
  Scale,
  ShieldCheck,
  Smartphone,
  Sparkles,
  SplitSquareHorizontal,
  Square,
  Star,
  Sun,
  Tag,
  Timer,
  Trees,
  Truck,
  Type,
  UserSquare,
  Users,
  Video,
  Zap,
} from 'lucide-react';
import type { AnalysisDimension } from '@/lib/brand-identity/types';

const SLATE = '#94a3b8';

/** Icon + accent color per taxonomy value, keyed `${dimension}:${label}`. */
const TACTIC_VISUALS: Record<string, { icon: LucideIcon; color: string }> = {
  // Formats (every AdFormat value has an explicit colour so none collides via
  // the hashed fallback - e.g. lifestyle_static used to hash to founder_talking's
  // cyan).
  'format:ugc': { icon: Video, color: '#ec4eb5' },
  'format:studio': { icon: Sparkles, color: '#8a4ce4' },
  'format:text_overlay_static': { icon: Type, color: '#10b981' },
  'format:meme': { icon: Images, color: '#f97316' },
  'format:founder_talking': { icon: UserSquare, color: '#06b6d4' },
  'format:product_demo': { icon: FlaskConical, color: '#3b82f6' },
  'format:before_after': { icon: SplitSquareHorizontal, color: '#14b8a6' },
  'format:carousel_listicle': { icon: LayoutGrid, color: '#6366f1' },
  'format:product_only_static': { icon: Package, color: '#0ea5e9' },
  'format:lifestyle_static': { icon: Sun, color: '#84cc16' },
  'format:unboxing': { icon: PackageOpen, color: '#f59e0b' },
  'format:tutorial_howto': { icon: GraduationCap, color: '#a855f7' },
  'format:testimonial_review': { icon: Quote, color: '#22c55e' },
  'format:social_screenshot': { icon: MessageSquare, color: '#d946ef' },
  'format:us_vs_them': { icon: Scale, color: '#f43f5e' },
  'format:press_advertorial': { icon: Newspaper, color: '#eab308' },
  'format:carousel_product_set': { icon: Images, color: '#2dd4bf' },
  'format:other': { icon: MoreHorizontal, color: SLATE },
  // Hooks
  'hook_archetype:problem_callout': { icon: Megaphone, color: '#f43f5e' },
  'hook_archetype:bold_claim': { icon: Star, color: '#f59e0b' },
  'hook_archetype:question': { icon: HelpCircle, color: '#ec4eb5' },
  'hook_archetype:social_proof': { icon: Users, color: '#10b981' },
  'hook_archetype:curiosity': { icon: Sparkles, color: '#8a4ce4' },
  'hook_archetype:offer_led': { icon: BadgePercent, color: '#3b82f6' },
  'hook_archetype:demo': { icon: FlaskConical, color: '#06b6d4' },
  'hook_archetype:testimonial': { icon: Quote, color: '#14b8a6' },
  'hook_archetype:comparison': { icon: GitCompare, color: '#6366f1' },
  'hook_archetype:other': { icon: MoreHorizontal, color: SLATE },
  // Offers
  'offer_type:discount': { icon: Percent, color: '#f59e0b' },
  'offer_type:free_shipping': { icon: Truck, color: '#3b82f6' },
  'offer_type:bundle': { icon: Gift, color: '#8a4ce4' },
  'offer_type:trial': { icon: FlaskConical, color: '#10b981' },
  'offer_type:none': { icon: Ban, color: SLATE },
  // Angles (LLM `angle` label - not the embedding clusters)
  'angle:pain_relief': { icon: HeartPulse, color: '#f43f5e' },
  'angle:convenience': { icon: Zap, color: '#f59e0b' },
  'angle:price_value': { icon: Tag, color: '#10b981' },
  'angle:status': { icon: Crown, color: '#8a4ce4' },
  'angle:health': { icon: Leaf, color: '#14b8a6' },
  'angle:time_saving': { icon: Clock, color: '#3b82f6' },
  'angle:trust_safety': { icon: ShieldCheck, color: '#06b6d4' },
  'angle:other': { icon: MoreHorizontal, color: SLATE },
  // Visual style (creative aesthetic - VISUAL_STYLES)
  'style:lo_fi_ugc': { icon: Video, color: '#ec4eb5' },
  'style:polished_studio': { icon: Sparkles, color: '#8a4ce4' },
  'style:designed_graphic': { icon: LayoutGrid, color: '#6366f1' },
  'style:screen_capture': { icon: Monitor, color: '#06b6d4' },
  'style:cinematic': { icon: Film, color: '#f43f5e' },
  'style:meme_style': { icon: Images, color: '#f97316' },
  'style:other': { icon: MoreHorizontal, color: SLATE },
  // Aspect ratio (ASPECT_RATIOS - labels carry a colon, e.g. 9:16)
  'aspect_ratio:9:16': { icon: Smartphone, color: '#ec4eb5' },
  'aspect_ratio:4:5': { icon: RectangleVertical, color: '#8a4ce4' },
  'aspect_ratio:1:1': { icon: Square, color: '#10b981' },
  'aspect_ratio:16:9': { icon: Monitor, color: '#3b82f6' },
  'aspect_ratio:other': { icon: MoreHorizontal, color: SLATE },
  // Tone (emotional register - TONES)
  'tone:humorous': { icon: Laugh, color: '#f59e0b' },
  'tone:aspirational': { icon: Star, color: '#8a4ce4' },
  'tone:educational': { icon: GraduationCap, color: '#3b82f6' },
  'tone:fear_urgency': { icon: AlertTriangle, color: '#f43f5e' },
  'tone:heartfelt': { icon: HeartPulse, color: '#ec4eb5' },
  'tone:plain_promotional': { icon: Megaphone, color: '#10b981' },
  'tone:other': { icon: MoreHorizontal, color: SLATE },
  // Setting (where the creative is shot - SETTINGS)
  'setting:home': { icon: Home, color: '#14b8a6' },
  'setting:studio': { icon: Camera, color: '#8a4ce4' },
  'setting:outdoor': { icon: Trees, color: '#10b981' },
  'setting:digital': { icon: Monitor, color: '#06b6d4' },
  'setting:other': { icon: MoreHorizontal, color: SLATE },
  // Pacing (video cut cadence - PACINGS; no 'other' value)
  'pacing:static': { icon: Pause, color: '#3b82f6' },
  'pacing:slow': { icon: Gauge, color: '#14b8a6' },
  'pacing:fast': { icon: Zap, color: '#f59e0b' },
  // Duration bucket (video length - DURATION_BUCKETS)
  'duration_bucket:lt15': { icon: Timer, color: '#10b981' },
  'duration_bucket:15_30': { icon: Clock, color: '#3b82f6' },
  'duration_bucket:30_60': { icon: Hourglass, color: '#f59e0b' },
  'duration_bucket:gt60': { icon: Film, color: '#f43f5e' },
};

/**
 * Vibrant fallback palette for taxonomy values without a hand-authored visual -
 * primarily the industry-specific `angle` labels (`transformation`, `gifting`,
 * `craftsmanship`, …) that vary per industry and can't all be enumerated above.
 * A label is mapped deterministically (by hash) so its dot/icon colour is stable
 * across renders and every angle gets its own distinct colour instead of grey.
 */
const FALLBACK_PALETTE = [
  '#ec4eb5', '#8a4ce4', '#10b981', '#f97316', '#06b6d4',
  '#3b82f6', '#14b8a6', '#6366f1', '#f43f5e', '#f59e0b',
  '#84cc16', '#a855f7', '#0ea5e9', '#22c55e', '#d946ef',
  '#eab308', '#2dd4bf', '#fb7185',
];

/** Varied icon pool (already-imported lucide icons) for fallback visuals. */
const FALLBACK_ICONS: LucideIcon[] = [
  Sparkles, Star, Zap, HeartPulse, Leaf, Crown, Tag, Gift,
  ShieldCheck, Megaphone, Quote, Clock, BadgePercent, GitCompare,
  Users, FlaskConical,
];

/** Stable non-negative hash of a label so its colour/icon never shifts. */
function hashLabel(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = (Math.imul(h, 31) + label.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Hand-authored visual for a taxonomy value, or undefined if none exists. */
function explicitTacticVisual(
  dimension: AnalysisDimension,
  label: string
): { icon: LucideIcon; color: string } | undefined {
  return (
    TACTIC_VISUALS[`${dimension}:${label}`] ??
    // angle_universal reuses the angle palette for the shared global labels.
    (dimension === 'angle_universal' ? TACTIC_VISUALS[`angle:${label}`] : undefined)
  );
}

export function tacticVisual(
  dimension: AnalysisDimension,
  label: string
): { icon: LucideIcon; color: string } {
  const explicit = explicitTacticVisual(dimension, label);
  if (explicit) return explicit;

  // Industry-specific angles (and any other unmapped label) get a deterministic
  // colourful visual rather than collapsing to grey.
  const h = hashLabel(label);
  return {
    icon: FALLBACK_ICONS[h % FALLBACK_ICONS.length],
    color: FALLBACK_PALETTE[h % FALLBACK_PALETTE.length],
  };
}

/**
 * Resolve visuals for a WHOLE dimension's set of labels at once, guaranteeing
 * every label gets a distinct accent colour. Per-label `tacticVisual()` can't do
 * this: independent hashing of unmapped labels (e.g. the industry-specific angle
 * labels `self care` and `natural ingredients`) can collide on the same palette
 * slot. Here we reserve the hand-authored colours first, then hand each remaining
 * label the nearest UNUSED palette colour (probing forward from its stable hash
 * slot). Colours stay deterministic and, unless a dimension has more labels than
 * the palette holds, never repeat within the dimension.
 */
export function assignTacticVisuals(
  dimension: AnalysisDimension,
  labels: string[]
): Map<string, { icon: LucideIcon; color: string }> {
  const result = new Map<string, { icon: LucideIcon; color: string }>();
  const usedColors = new Set<string>();

  // Pass 1: hand-authored (curated) visuals keep their exact colour.
  for (const label of labels) {
    if (result.has(label)) continue;
    const explicit = explicitTacticVisual(dimension, label);
    if (explicit) {
      result.set(label, explicit);
      usedColors.add(explicit.color);
    }
  }

  // Pass 2: every remaining label gets the nearest unused palette colour, probing
  // forward from its hash slot so no two labels in this dimension share a colour.
  for (const label of labels) {
    if (result.has(label)) continue;
    const h = hashLabel(label);
    let color = FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
    for (let i = 0; i < FALLBACK_PALETTE.length; i++) {
      const cand = FALLBACK_PALETTE[(h + i) % FALLBACK_PALETTE.length];
      if (!usedColors.has(cand)) {
        color = cand;
        break;
      }
    }
    usedColors.add(color);
    result.set(label, { icon: FALLBACK_ICONS[h % FALLBACK_ICONS.length], color });
  }

  return result;
}

export type QuadrantKey = 'power' | 'common' | 'gems' | 'under';

export const QUADRANTS: Record<
  QuadrantKey,
  { title: string; subtitle: string; color: string }
> = {
  power: { title: 'Power performers', subtitle: 'High win score · high usage', color: '#10b981' },
  common: { title: 'Common but average', subtitle: 'High win score · low usage', color: '#3b82f6' },
  gems: { title: 'Hidden gems', subtitle: 'Low win score · high usage', color: '#8a4ce4' },
  under: { title: 'Underperformers', subtitle: 'Low win score · low usage', color: '#f59e0b' },
};

/**
 * Which palette the "Winners vs the rest" matrix renders in.
 * - `category` - the default per-tactic multi-colour registry (Industry Explorer
 *   + classic competitor dashboard).
 * - `signal` - the monochrome-with-magenta treatment used by the Nimbus Signal
 *   overview: brand magenta is reserved for winners (the `power` quadrant),
 *   everything else recedes to neutral slate.
 */
export type MatrixColorScheme = 'category' | 'signal';

/** Brand magenta - the Signal scheme's single accent, reserved for winners. */
export const SIGNAL_ACCENT = '#ec4eb5';
/** Neutral slate for everything that isn't winning in the Signal scheme. */
export const SIGNAL_NEUTRAL = SLATE;

/**
 * Signal-scheme accent for a quadrant: magenta only for the winning (`power`)
 * quadrant - high win score AND high over-index - neutral slate for the rest.
 */
export function signalQuadrantColor(quadrant: QuadrantKey): string {
  return quadrant === 'power' ? SIGNAL_ACCENT : SIGNAL_NEUTRAL;
}

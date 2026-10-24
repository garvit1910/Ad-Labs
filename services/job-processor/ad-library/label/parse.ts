import { z } from 'zod';
import {
  ANGLES,
  DURATION_BUCKETS,
  FORMATS,
  FUNNEL_STAGES,
  HOOK_ARCHETYPES,
  OFFER_TYPES,
  PACINGS,
  PERSONAS,
  SETTINGS,
  TONES,
  VISUAL_STYLES,
} from '@/services/ad-library/label-taxonomy';

// Fingerprint attributes are all nullish: text-only labelling can't judge
// visual attributes, and video-only fields are absent for images/carousels.
const fingerprintSchema = z
  .object({
    people_present: z.boolean().nullish(),
    talking_head: z.boolean().nullish(),
    text_overlay: z.boolean().nullish(),
    setting: z.enum(SETTINGS).nullish(),
    voiceover: z.boolean().nullish(),
    pacing: z.enum(PACINGS).nullish(),
    spoken_hook: z.string().nullish(),
    duration_bucket: z.enum(DURATION_BUCKETS).nullish(),
    visual_hook: z.string().nullish(),
    captions: z.boolean().nullish(),
    music: z.boolean().nullish(),
    tone: z.enum(TONES).nullish(),
    execution_notes: z.string().nullish(),
  })
  .nullish();

// `angle` and `persona` are validated against the industry vocabulary in
// parseLabelItem (the allowed set is dynamic per batch group), so they stay
// plain strings here.
const labelItemSchema = z.object({
  library_ad_id: z.string(),
  hook_archetype: z.enum(HOOK_ARCHETYPES),
  angle: z.string(),
  angle_universal: z.enum(ANGLES),
  persona: z.string(),
  persona_universal: z.enum(PERSONAS),
  funnel_stage: z.enum(FUNNEL_STAGES),
  format: z.enum(FORMATS),
  // Nullish (not required) so pre-fingerprint model output and the text-only
  // path both parse; visual context is enforced in the row mapping.
  style: z.enum(VISUAL_STYLES).nullish(),
  fingerprint: fingerprintSchema,
  offer_type: z.enum(OFFER_TYPES),
  hook_text: z.string(),
  summary: z.string(),
  confidence: z.number(),
});

export const labelResponseSchema = z.object({
  ads: z.array(z.unknown()),
});

/** One validated model output item (see `parseLabelItem`). */
export type ParsedLabelItem = z.infer<typeof labelItemSchema>;

/** Carousel formats that require a genuine multi-card (2+) creative. */
const CAROUSEL_FORMATS = new Set(['carousel_listicle', 'carousel_product_set']);

/**
 * Validates one model output item. Returns null (drop) for malformed items,
 * unknown ad ids, an `angle` outside the group's vocabulary, or a `persona`
 * outside the group's vocabulary — rather than failing the whole batch.
 */
export function parseLabelItem(
  item: unknown,
  knownAdIds: Set<string>,
  allowedAngles: Set<string>,
  allowedPersonas: Set<string>,
  carouselEligibleAdIds?: Set<string>
): ParsedLabelItem | null {
  const parsed = labelItemSchema.safeParse(item);
  if (!parsed.success) return null;
  if (!knownAdIds.has(parsed.data.library_ad_id)) return null;
  if (!allowedAngles.has(parsed.data.angle)) return null;
  if (!allowedPersonas.has(parsed.data.persona)) return null;
  // Deterministic guard: a carousel format ("carousel_listicle" or
  // "carousel_product_set") requires a genuine multi-card creative. When a
  // card-eligibility set is provided and this ad is not in it (< 2 cards),
  // coerce the format to "other" — a single image/video is never a carousel no
  // matter what the model returned. The rest of the labelling is kept.
  const format =
    carouselEligibleAdIds &&
    CAROUSEL_FORMATS.has(parsed.data.format) &&
    !carouselEligibleAdIds.has(parsed.data.library_ad_id)
      ? 'other'
      : parsed.data.format;
  // Deterministic funnel tiebreak: an ad with a real offer AND an offer-led hook
  // is a bottom-of-funnel closer, whatever the model guessed for funnel_stage.
  const funnel_stage =
    parsed.data.funnel_stage === 'tof_problem' &&
    parsed.data.offer_type !== 'none' &&
    parsed.data.hook_archetype === 'offer_led'
      ? 'bof_offer'
      : parsed.data.funnel_stage;
  return {
    ...parsed.data,
    format,
    funnel_stage,
    confidence: Math.min(1, Math.max(0, parsed.data.confidence)),
  };
}

/**
 * Keeps the first row per library_ad_id. The upsert is keyed on library_ad_id,
 * so duplicate ids in one batch (a rare LLM double-emission) would otherwise
 * abort it with "ON CONFLICT DO UPDATE command cannot affect row a second time".
 */
export function dedupeByLibraryAdId<T extends { library_ad_id: string }>(
  rows: T[]
): T[] {
  const byAdId = new Map<string, T>();
  for (const row of rows) {
    if (!byAdId.has(row.library_ad_id)) byAdId.set(row.library_ad_id, row);
  }
  return Array.from(byAdId.values());
}

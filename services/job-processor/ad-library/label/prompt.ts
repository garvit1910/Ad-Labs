import {
  ANGLES,
  FORMATS,
  FUNNEL_STAGES,
  HOOK_ARCHETYPES,
  OFFER_TYPES,
  PERSONAS,
  SETTINGS,
  TONES,
  VISUAL_STYLES,
} from '@/services/ad-library/label-taxonomy';
import { reasoningParamsForRole } from '@/lib/llm/model-roles';
import type { AdToLabel } from './types';

/**
 * Strict JSON schema for one labelling call. The `angle`/`persona` enums are the
 * industry's vocabulary (high-resolution motivation + audience); `angle_universal`
 * and `persona_universal` are always the global ANGLES/PERSONAS lists (stable,
 * cross-industry comparison + safety net). `funnel_stage` marks the funnel
 * position. `tone` is judgeable from a static poster + copy, so the poster path
 * emits it (nullable). The video-only fingerprint attributes (duration_bucket,
 * visual_hook, captions, music) are deliberately ABSENT here — OpenAI strict
 * mode requires `required` to cover every key in `properties`, and only the
 * Gemini video path (prompt-templated, no strict schema) produces them; zod
 * accepts them downstream (same precedent as voiceover/pacing/spoken_hook).
 */
function buildResponseFormat(
  angleEnum: readonly string[],
  personaEnum: readonly string[]
) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'ad_labels',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ads'],
        properties: {
          ads: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'library_ad_id',
                'hook_archetype',
                'angle',
                'angle_universal',
                'persona',
                'persona_universal',
                'funnel_stage',
                'format',
                'style',
                'fingerprint',
                'offer_type',
                'hook_text',
                'summary',
                'confidence',
              ],
              properties: {
                library_ad_id: { type: 'string' },
                hook_archetype: { type: 'string', enum: [...HOOK_ARCHETYPES] },
                angle: { type: 'string', enum: [...angleEnum] },
                angle_universal: { type: 'string', enum: [...ANGLES] },
                persona: { type: 'string', enum: [...personaEnum] },
                persona_universal: { type: 'string', enum: [...PERSONAS] },
                funnel_stage: { type: 'string', enum: [...FUNNEL_STAGES] },
                format: { type: 'string', enum: [...FORMATS] },
                style: {
                  type: ['string', 'null'],
                  enum: [...VISUAL_STYLES, null],
                  description:
                    'Visual aesthetic of the creative, judged from the image; null when no image is provided',
                },
                fingerprint: {
                  type: ['object', 'null'],
                  additionalProperties: false,
                  required: [
                    'people_present',
                    'talking_head',
                    'text_overlay',
                    'setting',
                    'tone',
                    'execution_notes',
                  ],
                  properties: {
                    people_present: { type: ['boolean', 'null'] },
                    talking_head: { type: ['boolean', 'null'] },
                    text_overlay: { type: ['boolean', 'null'] },
                    setting: { type: ['string', 'null'], enum: [...SETTINGS, null] },
                    tone: { type: ['string', 'null'], enum: [...TONES, null] },
                    execution_notes: {
                      type: ['string', 'null'],
                      description:
                        'How the ad is staged and shot, as 1-3 short sentences of reusable, product-agnostic direction; null when no image is provided',
                    },
                  },
                  description:
                    'Visual attributes judged from the image; null when no image is provided',
                },
                offer_type: { type: 'string', enum: [...OFFER_TYPES] },
                hook_text: {
                  type: 'string',
                  description: 'The first-line hook extracted verbatim from the ad copy',
                },
                summary: {
                  type: 'string',
                  description: 'One sentence describing what the ad does',
                },
                confidence: {
                  type: 'number',
                  description: 'Labelling confidence from 0 to 1',
                },
              },
            },
          },
        },
      },
    },
  };
}

export function buildSystemPrompt(industryLabel: string | null): string {
  const industryLine = industryLabel
    ? `These ads are from a ${industryLabel} brand. Choose \`angle\` from the ${industryLabel}-specific options provided in the schema — the motivation that genuinely drives this vertical.`
    : 'Choose `angle` from the general options provided in the schema.';
  const personaLine = industryLabel
    ? `Choose \`persona\` from the ${industryLabel}-specific options provided in the schema — the specific customer group this ad speaks to.`
    : 'Choose `persona` from the general options provided in the schema.';
  return `You are an expert paid-social creative analyst. You label competitor ads for a creative-intelligence library. For every ad you receive, classify:
- hook_archetype: the persuasion mechanism of the opening hook
- angle: the underlying customer motivation the ad targets. ${industryLine}
- angle_universal: the same motivation expressed using the general, cross-industry angle vocabulary (so brands in different industries stay comparable)
- persona: the specific customer group the ad speaks to. ${personaLine}
- persona_universal: the same audience expressed using the general, cross-industry persona vocabulary (so brands in different industries stay comparable)
- funnel_stage: where in the funnel the ad operates — "tof_problem" problem/pain awareness for cold audiences, "mof_solution" solution comparison/benefits/how-it-works, "bof_offer" offer/urgency/retargeting closers
- format: the creative's PRODUCTION FORMAT (what the creative fundamentally IS), chosen from the schema enum. This is NOT the media container: the \`media_type\` field ("image" | "video" | "carousel" | "text") is provided separately and must not be copied into format. Pick the single best-fitting format. Use "other" ONLY when none of the named formats genuinely applies — do NOT default to "other" for an ordinary static product, offer, or lifestyle ad; those have named homes below.
  • VIDEO / creator formats (classify by how it was produced): "ugc" creator/customer phone-shot footage; "founder_talking" a founder or brand rep talking to camera; "product_demo" the product shown in use or in action; "testimonial_review" a customer testimonial or review; "tutorial_howto" a step-by-step how-to; "unboxing" an unboxing or first-look; "studio" a polished produced spot with no clear ugc/demo/testimonial framing.
  • STATIC IMAGE formats (single image — judge from what the image SHOWS, not the copy): "product_only_static" a product shot or packshot with little/no lifestyle scene or heavy text; "lifestyle_static" the product shown in a real-life scene, on a person, or in context; "text_overlay_static" a static dominated by overlaid caption or claim text; "before_after" a paired or side-by-side before/after; "social_screenshot" a screenshot of a post, review, DM, or news; "meme" meme-template humor; "us_vs_them" an explicit competitor/comparison layout; "press_advertorial" an editorial, "as seen in", or advertorial layout.
  • CAROUSEL formats (require 2+ static image cards): "carousel_product_set" a multi-card carousel showcasing products or variants WITHOUT a numbered-list structure; "carousel_listicle" a multi-card carousel with an actual numbered or enumerated list structure.
  NEVER label a video ad "carousel_listicle" or "carousel_product_set" just because its media_type is "carousel" or its copy lists points — classify a video by how it was produced (ugc, founder_talking, product_demo, studio, ...). A single static image is NEVER a carousel format. When torn between two static formats, prefer the more specific one over "other".
- offer_type: the explicit promotional offer, or "none" when the ad has no offer
- hook_text: the ad's first-line hook, quoted verbatim from the copy
- summary: one sentence on what the ad does and why it might work
- confidence: 0-1, how confident you are in this labelling overall
- style: the creative's visual AESTHETIC (how it looks, distinct from format): "lo_fi_ugc" phone-shot casual footage, "polished_studio" professional shoot, "designed_graphic" flat design/composed layout, "screen_capture" screen recording or app UI, "cinematic" filmic produced video, "meme_style" meme composition, or "other". Judge ONLY from the creative itself (image or video) — set null when you were given no visual.
- fingerprint: visual attributes of the creative — people_present (any person visible), talking_head (a person speaking to camera), text_overlay (prominent overlaid text), setting ("home" lived-in interior, "studio" controlled backdrop, "outdoor", "digital" pure graphic space, "other"), tone (the emotional register — "humorous", "aspirational", "educational", "fear_urgency", "heartfelt", "plain_promotional", "other" — judge from the creative plus copy), execution_notes (1-3 short sentences of STAGING DIRECTION another brand could reuse for a different product — camera framing and angle, subject arrangement, props, lighting, environment, mood. Describe only what you see. NEVER include the brand name, page name, product name, any person's name, or any text visible in the creative; write it fully product-agnostic — say "the product", "a person"). For VIDEO ads also: visual_hook (what is ON SCREEN in the first ~3 seconds, one short line), captions (burned-in subtitles present), music (a music track is present, separate from voiceover). Judge ONLY from the visual — set the whole object null when you were given no visual, and any single attribute null when it is not determinable.

Some ads include their creative's poster frame image immediately after their JSON. When an image is present, judge \`format\` primarily from what the image shows — a person talking to the camera in a casual setting → "ugc" or "founder_talking"; a static product shot or packshot → "product_only_static"; the product in a real-life scene or on a person → "lifestyle_static"; a polished product demo → "product_demo"; a static dominated by overlaid caption text → "text_overlay_static"; a screenshot of a post or review → "social_screenshot" — using the copy only as secondary evidence. The carousel constraints above still apply. When no image is present, fall back to the copy and, if the format is not evident from it, use "other".

Return one entry per ad with the exact library_ad_id you were given. Label every ad — never skip one.`;
}

/**
 * Splits one label batch into LLM calls: every ad WITH a poster image gets its
 * own single-ad call; all posterless ads share one batched text-only call.
 * gpt-4o-mini (the labeller until 2026-10-20) could not reliably bind N images to N ads in one request — in a
 * multi-image batch it mixes up which frame belongs to which ad (verified live:
 * a CGI-skull video labeled "ugc" in a 4-image batch, correct solo), so one
 * image per request is a correctness requirement, not a tuning choice.
 */
export function planLabelCalls(
  ads: AdToLabel[],
  posterByAdId: Map<string, string>
): AdToLabel[][] {
  const solo: AdToLabel[][] = [];
  const batched: AdToLabel[] = [];
  for (const ad of ads) {
    if (posterByAdId.has(ad.id)) solo.push([ad]);
    else batched.push(ad);
  }
  return batched.length > 0 ? [...solo, batched] : solo;
}

export function buildLabelRequestBody(
  ads: AdToLabel[],
  model: string,
  angleEnum: readonly string[],
  personaEnum: readonly string[],
  industryLabel: string | null,
  posterByAdId?: Map<string, string>
) {
  const adsForPrompt = ads.map((ad) => ({
    library_ad_id: ad.id,
    creative_bodies: ad.creative_bodies ?? [],
    creative_link_titles: ad.creative_link_titles ?? [],
    media_type: ad.media_type ?? 'unknown',
    page_name: ad.page_name ?? null,
  }));

  // With posters, the user message becomes interleaved parts — each ad's JSON
  // immediately followed by its poster frame at detail "low" (flat ~2.8K vision
  // tokens/image on gpt-4o-mini; production style is a coarse judgment, high
  // detail buys nothing). Without posters the plain-string shape is unchanged.
  let content: string | Array<Record<string, unknown>>;
  if (posterByAdId && posterByAdId.size > 0) {
    const parts: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: `Label these ${ads.length} ads. Each ad's JSON is followed by its creative poster frame when available:`,
      },
    ];
    for (const adForPrompt of adsForPrompt) {
      parts.push({ type: 'text', text: JSON.stringify(adForPrompt, null, 2) });
      const poster = posterByAdId.get(adForPrompt.library_ad_id);
      if (poster) {
        parts.push({ type: 'image_url', image_url: { url: poster, detail: 'low' } });
      }
    }
    content = parts;
  } else {
    content = `Label these ${ads.length} ads:\n${JSON.stringify(adsForPrompt, null, 2)}`;
  }

  return {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(industryLabel) },
      { role: 'user', content },
    ],
    response_format: buildResponseFormat(angleEnum, personaEnum),
    temperature: 0.2,
    // gpt-6-luna runs at effort none (no reasoning tokens); omitted for gpt-4o-mini.
    ...reasoningParamsForRole('ad_label', model),
  };
}

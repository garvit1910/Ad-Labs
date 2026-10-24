/**
 * Image renderer v5 — one pack in, reference asset refs + a short ordered
 * prompt out: scene → subject → brand style cues → quality → constraints
 * LAST.
 *
 * v5 (2026-09-22, Magic Spoon near-identical-images fix): three changes, all
 * aimed at images that read the same regardless of the ad copy.
 * (1) The `Concept: <angle>` clause is DROPPED when `spec.angleTheme` is set:
 * that field exists only when the angle provably came from the strategy
 * selector, where `spec.angle` is deterministic boilerplate ("Lead with the
 * … angle proven by winning ads …") that means nothing to an image model.
 * Explicit human/agent angle prose (no angleTheme) still renders.
 * (2) The key claim is ALWAYS rendered when a brand fact exists — including
 * with product references, which previously suppressed it, so no fact ever
 * reached brands with product photos. It is the first NON-lesson fact (a
 * derived performance lesson is a strategy directive, not a claim) and is
 * expressed through scene/props/mood, never as written text.
 * (3) Scene relevance no longer demands "the scene a customer would
 * photograph in real life" (which forced every image to the same literal
 * usage moment); stylised, conceptual, graphic, and editorial compositions
 * are allowed as long as every element relates to the product, its
 * ingredients, its benefit, or its customer.
 *
 * v4 (2026-08-05 prompt-injection hardening, matching copy/judge v3): every
 * row-derived string rendered into the prompt (persona description, key-claim
 * fact statement, voice mood cues, palette values) goes through
 * `collapseWhitespace`. This prompt has no `## ` section structure to forge,
 * but review-derived content carrying newlines could still break the segment
 * ordering the constraints-LAST contract depends on. Spec-echo fields (angle,
 * product, platform, the audience override) render as authored — same
 * contract as copy.ts. Reference asset URLs are NOT collapsed: they go to the
 * image provider as URLs, never into prompt prose, and silently repairing a
 * malformed one would hide an ingest bug.
 *
 * v3 (2026-08-04 incident fix, run 403ede09): a dedicated photographic
 * QUALITY segment (the user's directive — quality comes from the generation
 * prompt, not a blocking judge), and a CONDITIONAL packaging constraint:
 * with product references the packaging is reproduced faithfully; WITHOUT
 * references the packaging must be clean/unbranded with NO readable text —
 * an ungrounded model otherwise invents brand names (a live run rendered a
 * competitor cereal brand onto the product) and fake disclaimers.
 *
 * v2 clean-image doctrine (the v1 "completely text-free" constraint told the
 * model to strip the brand's own logo OFF the product packaging — the single
 * worst quality failure): the ONLY text allowed is text that physically
 * exists on the product itself (label, packaging, printed logo), which MUST
 * be reproduced faithfully; ADDED text, banner bands, buttons, CTA pills,
 * and watermarks are banned (headline/CTA are platform ad fields now — no
 * compositor bands exist). Constraints also demand exact product fidelity to
 * the reference images and scene relevance (every prop motivated by real
 * product usage — no unrelated crowds/devices/venues).
 *
 * Phase-5 insertion point: the per-candidate variation modifier goes BETWEEN
 * style and constraints — [scene, subject, style, variation.text,
 * constraints].join(' ') — so constraints stay last. Variation is per-run
 * candidate state, never pack content.
 */
import { isLessonRowId } from '../lessons';
import { type BrandContextPack, type SlotEntry } from '../types';
import {
  assertKnownAspectRatio,
  assertRendererVersion,
  collapseWhitespace,
  IMAGE_REFERENCE_ASSET_CAP,
  malformedRow,
  optionalString,
  requireString,
  STORY_SAFE_ZONE_9_16,
} from './shared';

export interface ImageReferenceAsset {
  /** Slot entry rowId, e.g. 'asset_brand_logo' — lineage-traceable. */
  id: string;
  kind: 'logo' | 'product_image';
  url: string;
}

export interface ImageRenderSegments {
  scene: string;
  subject: string;
  style: string;
  /** v3: production-grade photographic standards (fixed template). */
  quality: string;
  constraints: string;
}

export interface ImageRender {
  segments: ImageRenderSegments;
  /** Segments joined with ' ' in order — constraints ALWAYS last. */
  prompt: string;
  /** URL-bearing assets (logo, product_image) in slot order, 0–4 entries. */
  referenceAssets: ImageReferenceAsset[];
}

const ADDED_TEXT_CONSTRAINT =
  'Constraints: do not ADD any text, headlines, captions, banner bands, buttons, CTA pills, watermarks, or floating logos to the image. Never render invented brand names, slogans, disclaimers, or legal text anywhere in the image. The ONLY text allowed is text that physically exists on the product itself — its real label, packaging, and printed logo — which MUST be reproduced faithfully.';
const PRODUCT_FIDELITY_CONSTRAINT =
  'The product must match the reference images EXACTLY: same packaging shape, label design, printed text, logo, and colors. Do not restyle, redesign, blur, or replace the label or logo.';
const UNBRANDED_WITHOUT_REFERENCE_CONSTRAINT =
  "No product reference images were provided, so the product's packaging must be CLEAN and UNBRANDED with NO readable text — never invent a brand name, logo, label text, slogan, or disclaimer. A plain, text-free package is correct; invented text is a failure.";
const QUALITY_SEGMENT =
  'Quality: award-grade commercial product photography — tack-sharp focus on the product, physically accurate lighting and shadows, coherent perspective, realistic materials and textures, professional color grading. No warped geometry, no duplicated or extra objects, no surreal artifacts.';
const SCENE_RELEVANCE_CONSTRAINT =
  'Stylised, conceptual, graphic, or editorial compositions (a bold colour-blocked still life, a metaphorical staging of the benefit) are welcome, but every element must relate to the product, its ingredients, its benefit, or its customer. No unrelated or unmotivated props, crowds, devices, screens, venues, or decorative clutter.';
const FALLBACK_STYLE = 'Clean, modern commercial aesthetic.';
const LOGO_REFERENCE_NOTE =
  'Use the logo reference image to reproduce the brand identity accurately WHERE IT PHYSICALLY APPEARS on the product or packaging — never as a floating overlay or watermark.';

function isReferenceKind(kind: unknown): kind is ImageReferenceAsset['kind'] {
  return kind === 'logo' || kind === 'product_image';
}

const KNOWN_ASSET_KINDS = [
  'logo',
  'color_palette',
  'font_pair',
  'product_image',
];

function collectReferenceAssets(
  pack: BrandContextPack,
): ImageReferenceAsset[] {
  const refs: ImageReferenceAsset[] = [];
  for (const entry of pack.slots.assets) {
    const kind = optionalString(entry, 'kind');
    if (!kind || !KNOWN_ASSET_KINDS.includes(kind)) {
      // A new ingest asset kind must consciously bump the image renderer
      // version; this throw is what surfaces the omission.
      malformedRow(entry, 'assets', `has an unknown asset kind "${kind ?? ''}"`);
    }
    if (isReferenceKind(kind)) {
      refs.push({
        id: entry.id,
        kind,
        url: requireString(entry, 'url', 'assets'),
      });
    }
  }
  return refs.slice(0, IMAGE_REFERENCE_ASSET_CAP);
}

function sceneSegment(pack: BrandContextPack): string {
  const { spec } = pack.meta;
  // The override is spec echo (rendered as authored, matching copy.ts); the
  // persona description is row content and is collapsed.
  const audience =
    spec.overrides?.audience ??
    collapseWhitespace(
      requireString(pack.slots.persona, 'description', 'persona'),
    );
  // v5: a strategy-selected angle (angleTheme set) is selector boilerplate,
  // not a concept an image model can depict — omit it; explicit prose stays.
  const concept = spec.angleTheme ? '' : ` Concept: ${spec.angle}.`;
  return `Photorealistic commercial ${spec.platform} ad photograph.${concept} Audience: ${audience}.`;
}

function keyClaimCue(pack: BrandContextPack): string {
  // The first BRAND fact: lessons ride the facts slot (appended last) but are
  // strategy directives, never a claim to visualize. The compiler refuses a
  // pack with zero brand facts (EMPTY_PACK); a hand-built one degrades to no
  // cue rather than throwing.
  const fact = pack.slots.facts.find((entry) => !isLessonRowId(entry.id));
  if (!fact) return '';
  const keyClaim = collapseWhitespace(
    requireString(fact, 'statement', 'facts'),
  );
  return ` Key claim this image should make visible through the scene (never as written text): "${keyClaim}".`;
}

function subjectSegment(
  pack: BrandContextPack,
  hasProductReference: boolean,
): string {
  const { spec } = pack.meta;
  const matched = hasProductReference
    ? ', reproduced exactly as shown in the reference images — including its label and packaging text.'
    : '.';
  const hero = spec.product ?? "the brand's product";
  return `Hero subject: ${hero}${matched}${keyClaimCue(pack)}`;
}

function paletteCue(entry: SlotEntry): string {
  const parts = [
    ['primary', optionalString(entry, 'primary')],
    ['secondary', optionalString(entry, 'secondary')],
    ['accent', optionalString(entry, 'accent')],
  ]
    .filter((pair): pair is [string, string] => Boolean(pair[1]))
    .map(([name, value]): [string, string] => [
      name,
      collapseWhitespace(value),
    ]);
  if (parts.length === 0) {
    // Ingest only mints a color_palette row when at least one key is present.
    malformedRow(entry, 'assets', 'has no primary/secondary/accent color');
  }
  return `Brand palette: ${parts.map(([name, hex]) => `${name} ${hex}`).join(', ')}.`;
}

function styleSegment(
  pack: BrandContextPack,
  hasLogoReference: boolean,
): string {
  const parts: string[] = [];
  const palette = pack.slots.assets.find(
    (entry) => optionalString(entry, 'kind') === 'color_palette',
  );
  if (palette) parts.push(paletteCue(palette));
  if (pack.slots.voice.length > 0) {
    // Collapse FIRST, then strip trailing periods, so a statement ending in
    // ".\n" still loses its terminator and never doubles with the cue's own.
    const moods = pack.slots.voice.map((entry) =>
      collapseWhitespace(requireString(entry, 'statement', 'voice')).replace(
        /\.+$/,
        '',
      ),
    );
    parts.push(`Mood: ${moods.join('; ')}.`);
  }
  if (hasLogoReference) parts.push(LOGO_REFERENCE_NOTE);
  // font_pair assets contribute nothing: added typography is banned and the
  // packaging's own printed type comes from the reference images.
  return parts.length > 0 ? parts.join(' ') : FALLBACK_STYLE;
}

function constraintsSegment(
  pack: BrandContextPack,
  hasProductReference: boolean,
): string {
  const { aspectRatio } = pack.meta.spec;
  assertKnownAspectRatio(aspectRatio);
  const parts = [ADDED_TEXT_CONSTRAINT];
  // With references the packaging is reproduced faithfully; without them an
  // ungrounded model invents brands/disclaimers — force clean unbranded
  // packaging instead.
  parts.push(
    hasProductReference
      ? PRODUCT_FIDELITY_CONSTRAINT
      : UNBRANDED_WITHOUT_REFERENCE_CONSTRAINT,
  );
  parts.push(SCENE_RELEVANCE_CONSTRAINT);
  if (aspectRatio === '9:16') parts.push(STORY_SAFE_ZONE_9_16);
  return parts.join(' ');
}

export function renderImagePrompt(pack: BrandContextPack): ImageRender {
  assertRendererVersion(pack, 'image');
  const referenceAssets = collectReferenceAssets(pack);
  const hasProductReference = referenceAssets.some(
    (ref) => ref.kind === 'product_image',
  );
  const hasLogoReference = referenceAssets.some((ref) => ref.kind === 'logo');
  const segments: ImageRenderSegments = {
    scene: sceneSegment(pack),
    subject: subjectSegment(pack, hasProductReference),
    style: styleSegment(pack, hasLogoReference),
    quality: QUALITY_SEGMENT,
    constraints: constraintsSegment(pack, hasProductReference),
  };
  return {
    segments,
    prompt: [
      segments.scene,
      segments.subject,
      segments.style,
      segments.quality,
      segments.constraints,
    ].join(' '),
    referenceAssets,
  };
}

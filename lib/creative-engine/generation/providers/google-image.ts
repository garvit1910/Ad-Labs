/**
 * Google (Gemini) creative-image provider via the Generative Language REST API.
 *
 * Pure fetch — no SDK, no DB. GEMINI_API_KEY is read at CALL time (never at
 * import time) so importing this module without the key configured is safe.
 */

import type {
  CreativeImageProvider,
  GenerationRequest,
  GenerationResult,
  ImageRef,
  ProviderEditOptions,
} from '@/lib/creative-engine/generation/types';
import {
  buildTimeoutSignal,
  readErrorSnippet,
  resolveRequestTimeoutMs,
} from './shared';
import { reportImageUsage } from '@/lib/llm/clients/usage';
import { fetchCreativeImage } from '../safe-image-fetch';
import { resolveGoogleImageModel } from '../model-resolvers';

// Default image model (CREATIVE_IMAGE_GOOGLE_MODEL, default
// gemini-3.1-flash-image): the resolver + its verification note live in
// ../model-resolvers.
export { resolveGoogleImageModel };

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
/** Verified 2026-07-02: gemini-3.1-flash-image accepts up to 10 object reference images. */
const MAX_REFERENCE_IMAGES = 10;

/**
 * Documented native aspect ratios for gemini-3.1-flash-image. Dims are mapped
 * to the closest supported ratio string for the request config.
 */
const SUPPORTED_RATIOS: Array<{ ratio: string; value: number }> = [
  { ratio: '1:1', value: 1 },
  { ratio: '4:5', value: 4 / 5 },
  { ratio: '3:4', value: 3 / 4 },
  { ratio: '2:3', value: 2 / 3 },
  { ratio: '9:16', value: 9 / 16 },
  { ratio: '5:4', value: 5 / 4 },
  { ratio: '4:3', value: 4 / 3 },
  { ratio: '3:2', value: 3 / 2 },
  { ratio: '16:9', value: 16 / 9 },
  { ratio: '21:9', value: 21 / 9 },
];

function closestAspectRatio(width: number, height: number): string {
  const target = width / height;
  let best = SUPPORTED_RATIOS[0];
  for (const candidate of SUPPORTED_RATIOS) {
    if (Math.abs(candidate.value - target) < Math.abs(best.value - target)) {
      best = candidate;
    }
  }
  return best.ratio;
}

/** Hard per-request timeout merged with the caller's signal (shared helper). */
function buildRequestSignal(callerSignal?: AbortSignal): AbortSignal {
  return buildTimeoutSignal(callerSignal, resolveRequestTimeoutMs());
}

function requireApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not configured — cannot call the Gemini image API.');
  }
  return key;
}

interface GeminiInlinePart {
  inlineData?: { mimeType?: string; data?: string };
  text?: string;
}

interface GeminiPayload {
  candidates?: Array<{ content?: { parts?: GeminiInlinePart[] } }>;
  /** Gemini returns token counts for image calls too (promptTokenCount, …). */
  usageMetadata?: unknown;
}

async function fetchInlineImagePart(
  url: string,
  signal: AbortSignal
): Promise<GeminiInlinePart> {
  // Through the creative-image SSRF guard: Adcero asset hosts or `data:` only.
  const { buffer, contentType } = await fetchCreativeImage(url, { signal, label: 'reference image' });
  return { inlineData: { mimeType: contentType, data: buffer.toString('base64') } };
}

async function callGenerateContent(
  model: string,
  parts: GeminiInlinePart[],
  signal: AbortSignal,
  aspectRatio?: string
): Promise<GenerationResult> {
  const apiKey = requireApiKey();

  const post = (config: Record<string, unknown>) =>
    fetch(`${BASE_URL}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: config,
      }),
      signal,
    });

  // Native aspect ratio rides `generationConfig.imageConfig` (nano-banana
  // config shape). The exact field could not be pinned from the fetched REST
  // reference (page truncation), so this SELF-HEALS: a 400 naming the field
  // retries once WITHOUT imageConfig — the prompt still carries the ratio
  // instruction, so the fallback degrades to the previous behavior.
  let res = aspectRatio
    ? await post({
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio },
      })
    : await post({ responseModalities: ['TEXT', 'IMAGE'] });

  if (!res.ok && aspectRatio && res.status === 400) {
    const snippet = await readErrorSnippet(res);
    if (/imageConfig|image_config|aspectRatio|aspect_ratio/i.test(snippet)) {
      console.warn(
        `[GoogleImageProvider] imageConfig rejected by ${model}; retrying without native aspect ratio: ${snippet}`
      );
      res = await post({ responseModalities: ['TEXT', 'IMAGE'] });
    } else {
      throw new Error(`Gemini image generation failed (400): ${snippet}`);
    }
  }
  if (!res.ok) {
    throw new Error(
      `Gemini image generation failed (${res.status}): ${await readErrorSnippet(res)}`
    );
  }
  const payload = (await res.json()) as GeminiPayload;

  // Cost metering (WS-1): this provider bypasses lib/llm/clients entirely, so
  // without this the call is invisible to the usage sink. Both generate() and
  // edit() funnel through here.
  reportImageUsage(model, payload.usageMetadata);

  const responseParts = payload.candidates?.[0]?.content?.parts ?? [];
  const imagePart = responseParts.find((part) => part.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    throw new Error('Gemini image API returned no inline image data (possibly safety-blocked).');
  }
  return {
    imageBuffer: Buffer.from(imagePart.inlineData.data, 'base64'),
    contentType: imagePart.inlineData.mimeType || 'image/png',
    model,
  };
}

export interface GoogleImageProviderOptions {
  /** Model override (a generation profile's image model); env resolver otherwise. */
  model?: string;
}

export function createGoogleImageProvider(
  opts: GoogleImageProviderOptions = {}
): CreativeImageProvider {
  // Resolved at READ time (a getter), exactly like the call-time env read it
  // replaced — no env value is frozen at construction.
  const resolveModel = (): string => opts.model ?? resolveGoogleImageModel();
  return {
    name: 'google',
    get model(): string {
      return resolveModel();
    },
    capabilities: {
      textToImage: true,
      imageEdit: true,
      referenceImages: MAX_REFERENCE_IMAGES,
      inImageText: 'good',
      // Native-ratio outputs (SUPPORTED_RATIOS) — these four cover the
      // pipeline's AspectRatio union at 1K-tier dimensions.
      sizes: [
        { width: 1024, height: 1024 },
        { width: 1024, height: 1280 },
        { width: 1080, height: 1920 },
        { width: 1920, height: 1080 },
      ],
    },

    async generate(req: GenerationRequest): Promise<GenerationResult> {
      const signal = buildRequestSignal(req.signal);
      const aspectRatio = closestAspectRatio(req.width, req.height);
      const parts: GeminiInlinePart[] = [
        {
          text:
            `${req.prompt}\n` +
            `Render as a single image at approximately ${req.width}x${req.height} pixels ` +
            `(preserve that aspect ratio).`,
        },
      ];
      // Reference-image grounding is best-effort: a failed reference fetch
      // downgrades to prompt-only generation instead of failing the candidate
      // (product_fidelity gate reports 'unverified' pass-through regardless).
      for (const url of (req.referenceImages ?? []).slice(0, MAX_REFERENCE_IMAGES)) {
        try {
          parts.push(await fetchInlineImagePart(url, signal));
        } catch (error) {
          console.warn(
            '[GoogleImageProvider] Skipping unreachable reference image:',
            error instanceof Error ? error.message : error
          );
        }
      }
      return callGenerateContent(resolveModel(), parts, signal, aspectRatio);
    },

    async edit(
      image: ImageRef,
      instruction: string,
      opts?: ProviderEditOptions
    ): Promise<GenerationResult> {
      const signal = buildRequestSignal(opts?.signal);
      // Gemini's documented editing pattern: source image inline + a text
      // instruction in the same `generateContent` request. A targetSize rides
      // the same self-healing imageConfig.aspectRatio path as generate() —
      // the aspect-ratio outpaint seam.
      const sourcePart = await fetchInlineImagePart(image.url, signal);
      const aspectRatio = opts?.targetSize
        ? closestAspectRatio(opts.targetSize.width, opts.targetSize.height)
        : undefined;
      const result = await callGenerateContent(
        resolveModel(),
        [sourcePart, { text: instruction }],
        signal,
        aspectRatio
      );
      return { ...result, metadata: { ...result.metadata, edited: true } };
    },

    estimateCostCents(): number {
      // Verified 2026-07-02 (ai.google.dev/gemini-api/docs/pricing):
      // gemini-3.1-flash-image ≈ $0.067 per 1K image → 7c rounded up. Gemini
      // bills by resolution tier, not quality — the ImageQuality knob is a
      // no-op for this provider (OpenAI carries the tiered-pricing lever).
      return 7;
    },
  };
}

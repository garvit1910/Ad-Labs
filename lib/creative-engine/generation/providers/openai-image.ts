/**
 * OpenAI creative-image provider (gpt-image family).
 *
 * Pure fetch — no SDK, no DB. API key is read at CALL time (never at import
 * time) so importing this module without OPENAI_API_KEY configured is safe.
 */

import type {
  CreativeImageProvider,
  GenerationRequest,
  GenerationResult,
  ImageQuality,
  ImageRef,
  ProviderEditOptions,
  ProviderSize,
} from '@/lib/creative-engine/generation/types';
import {
  buildTimeoutSignal,
  readErrorSnippet,
  resolveRequestTimeoutMs,
} from './shared';
import { reportImageUsage } from '@/lib/llm/clients/usage';
import { fetchCreativeImage } from '../safe-image-fetch';
import { resolveOpenAIImageModel } from '../model-resolvers';

// Default image model (CREATIVE_IMAGE_OPENAI_MODEL, default gpt-image-2): the
// resolver + its verification note live in ../model-resolvers.
export { resolveOpenAIImageModel };

const GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
const EDITS_URL = 'https://api.openai.com/v1/images/edits';

/**
 * Reference-image inputs on /v1/images/edits — the official docs' composition
 * example uses 4 input images, which we adopt as the verified-safe cap
 * (gpt-image-2 accepts multiple; an exact documented maximum was not stated).
 */
const MAX_REFERENCE_IMAGES = 4;

/**
 * gpt-image-2 accepts flexible resolutions (multiples of 16px, ≤3840px edge);
 * we keep the documented "popular sizes" set and snap to it so cost estimation
 * stays predictable.
 */
const SUPPORTED_SIZES: ProviderSize[] = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

/**
 * Default quality tier is deliberately explicit (never rely on the API-side
 * default, which may be the most expensive tier). Overridable per request
 * (pipeline wide-generation tier) — see cost.ts resolveWideQuality.
 */
const DEFAULT_QUALITY: ImageQuality = 'medium';

/**
 * Per-image pricing verified 2026-07-02 from the official gpt-image-2 table
 * (cents, rounded up): low $0.005–0.006, medium $0.041–0.053, high
 * $0.165–0.211. Square renders price slightly above the rectangular sizes.
 */
const COST_CENTS: Record<ImageQuality, { square: number; rect: number }> = {
  low: { square: 1, rect: 1 },
  medium: { square: 6, rect: 5 },
  high: { square: 22, rect: 17 },
};

/** Hard per-request timeout merged with the caller's signal (shared helper). */
function buildRequestSignal(callerSignal?: AbortSignal): AbortSignal {
  return buildTimeoutSignal(callerSignal, resolveRequestTimeoutMs());
}

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is not configured — cannot call the OpenAI image API.');
  }
  return key;
}

function snapToSupportedSize(width: number, height: number): string {
  if (width === height) return '1024x1024';
  return width > height ? '1536x1024' : '1024x1536';
}

interface OpenAIImagePayload {
  data?: Array<{ b64_json?: string; revised_prompt?: string }>;
  /** gpt-image responses may carry a token usage block; older ones do not. */
  usage?: unknown;
}

function parseImagePayload(payload: OpenAIImagePayload, model: string): GenerationResult {
  // Cost metering (WS-1): this provider bypasses lib/llm/clients entirely, so
  // the call itself would otherwise be invisible to the usage sink. Reported on
  // every successful response (generate, reference-conditioned, and edit all
  // land here); tokens only when the response actually carries `usage`.
  reportImageUsage(model, payload.usage);

  const first = payload.data?.[0];
  if (!first?.b64_json) {
    throw new Error('OpenAI image API returned no b64_json image data.');
  }
  const result: GenerationResult = {
    imageBuffer: Buffer.from(first.b64_json, 'base64'),
    contentType: 'image/png',
    model,
  };
  if (first.revised_prompt) result.revisedPrompt = first.revised_prompt;
  return result;
}

/** Through the creative-image SSRF guard: Adcero asset hosts or `data:` only. */
async function fetchImageBlob(url: string, signal: AbortSignal, label: string): Promise<Blob> {
  const { buffer, contentType } = await fetchCreativeImage(url, { signal, label });
  return new Blob([new Uint8Array(buffer)], { type: contentType });
}

/**
 * Reference-conditioned generation rides /v1/images/edits — per the official
 * docs, the edits endpoint "lets you edit existing images, generate new images
 * using other images as a reference" (multipart, multiple `image[]` files).
 */
async function generateWithReferences(
  req: GenerationRequest,
  apiKey: string,
  model: string,
  signal: AbortSignal
): Promise<GenerationResult> {
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', req.prompt);
  form.set('size', snapToSupportedSize(req.width, req.height));
  form.set('quality', req.quality ?? DEFAULT_QUALITY);
  const refs = (req.referenceImages ?? []).slice(0, MAX_REFERENCE_IMAGES);
  for (const [i, url] of refs.entries()) {
    form.append('image[]', await fetchImageBlob(url, signal, `reference image ${i + 1}`), `ref-${i}.png`);
  }

  const res = await fetch(EDITS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `OpenAI reference-conditioned generation failed (${res.status}): ${await readErrorSnippet(res)}`
    );
  }
  return parseImagePayload((await res.json()) as OpenAIImagePayload, model);
}

export interface OpenAIImageProviderOptions {
  /** Model override (a generation profile's image model); env resolver otherwise. */
  model?: string;
}

export function createOpenAIImageProvider(
  opts: OpenAIImageProviderOptions = {}
): CreativeImageProvider {
  // Resolved at READ time (a getter), exactly like the call-time env read it
  // replaced — no env value is frozen at construction.
  const resolveModel = (): string => opts.model ?? resolveOpenAIImageModel();
  return {
    name: 'openai',
    get model(): string {
      return resolveModel();
    },
    capabilities: {
      textToImage: true,
      imageEdit: true,
      referenceImages: MAX_REFERENCE_IMAGES,
      inImageText: 'good',
      sizes: SUPPORTED_SIZES,
    },

    async generate(req: GenerationRequest): Promise<GenerationResult> {
      const apiKey = requireApiKey();
      const model = resolveModel();
      const signal = buildRequestSignal(req.signal);

      // Product refs present → reference-conditioned generation via /edits
      // (render the REAL product); otherwise plain text-to-image.
      if ((req.referenceImages?.length ?? 0) > 0) {
        return generateWithReferences(req, apiKey, model, signal);
      }

      // gpt-image models return base64 (b64_json) by default and reject the
      // legacy `response_format` param, so it is deliberately omitted.
      const res = await fetch(GENERATIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt: req.prompt,
          n: 1,
          size: snapToSupportedSize(req.width, req.height),
          quality: req.quality ?? DEFAULT_QUALITY,
        }),
        signal,
      });
      if (!res.ok) {
        throw new Error(
          `OpenAI image generation failed (${res.status}): ${await readErrorSnippet(res)}`
        );
      }
      return parseImagePayload((await res.json()) as OpenAIImagePayload, model);
    },

    async edit(
      image: ImageRef,
      instruction: string,
      opts?: ProviderEditOptions
    ): Promise<GenerationResult> {
      const apiKey = requireApiKey();
      const model = resolveModel();
      const signal = buildRequestSignal(opts?.signal);

      // /v1/images/edits: multipart form with the source image binary + an
      // edit prompt; base64 response like generations (verified 2026-07-02
      // against the official image-generation guide).
      const blob = await fetchImageBlob(image.url, signal, 'source image');

      const form = new FormData();
      form.set('model', model);
      form.set('prompt', instruction);
      form.set('image', blob, 'source.png');
      // Aspect-ratio outpaint: /edits accepts the same `size` values as
      // generations; setting it re-frames the output canvas.
      if (opts?.targetSize) {
        form.set('size', snapToSupportedSize(opts.targetSize.width, opts.targetSize.height));
      }

      const res = await fetch(EDITS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });
      if (!res.ok) {
        throw new Error(
          `OpenAI image edit failed (${res.status}): ${await readErrorSnippet(res)}`
        );
      }
      const result = parseImagePayload((await res.json()) as OpenAIImagePayload, model);
      return { ...result, metadata: { ...result.metadata, edited: true } };
    },

    estimateCostCents(req: Pick<GenerationRequest, 'width' | 'height' | 'quality'>): number {
      const tier = COST_CENTS[req.quality ?? DEFAULT_QUALITY];
      return req.width === req.height ? tier.square : tier.rect;
    },
  };
}

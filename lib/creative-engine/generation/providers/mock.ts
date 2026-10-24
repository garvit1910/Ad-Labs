/**
 * Deterministic mock creative-image provider.
 *
 * No network, no API keys — every call resolves synchronously-fast with a
 * hardcoded 1x1 PNG. Used as the zero-key fallback in provider resolution
 * (see `./index.ts`) and as the default provider for tests/local dev so the
 * whole generation pipeline is exercisable without any spend.
 */

import type {
  CreativeImageProvider,
  GenerationRequest,
  GenerationResult,
  ImageRef,
  ProviderEditOptions,
} from '@/lib/creative-engine/generation/types';

/**
 * Smallest valid PNG (1x1). Decodes to a real PNG signature + IHDR/IDAT/IEND,
 * so downstream consumers (persistence, content-type sniffing) see a genuine
 * image payload.
 */
const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const MOCK_IMAGE_MODEL = 'mock-image-v1';

function mockResult(model: string, metadata: Record<string, unknown>): GenerationResult {
  return {
    imageBuffer: Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'),
    contentType: 'image/png',
    model,
    metadata,
  };
}

export interface MockImageProviderOptions {
  /** Model label override (a generation profile's image model); MOCK_IMAGE_MODEL otherwise. */
  model?: string;
}

export function createMockImageProvider(
  opts: MockImageProviderOptions = {}
): CreativeImageProvider {
  const model = opts.model ?? MOCK_IMAGE_MODEL;
  return {
    name: 'mock',
    model,
    capabilities: {
      textToImage: true,
      imageEdit: true,
      referenceImages: 8,
      inImageText: 'good',
      sizes: [
        { width: 1024, height: 1024 },
        { width: 1024, height: 1280 },
        { width: 1080, height: 1920 },
        { width: 1920, height: 1080 },
      ],
    },
    async generate(req: GenerationRequest): Promise<GenerationResult> {
      return mockResult(model, {
        prompt: req.prompt,
        width: req.width,
        height: req.height,
        referenceImageCount: req.referenceImages?.length ?? 0,
      });
    },
    async edit(
      image: ImageRef,
      instruction: string,
      opts?: ProviderEditOptions
    ): Promise<GenerationResult> {
      return mockResult(model, {
        edited: true,
        sourceUrl: image.url,
        instruction,
        ...(opts?.targetSize
          ? { targetWidth: opts.targetSize.width, targetHeight: opts.targetSize.height }
          : {}),
      });
    },
    estimateCostCents(): number {
      return 0;
    },
  };
}

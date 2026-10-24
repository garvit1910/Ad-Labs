/**
 * Creative image provider registry/factory.
 *
 * Resolution order (never throws at import time — all env reads happen inside
 * the exported functions, and provider API keys are only read at call time):
 *   1. explicit name argument
 *   2. env CREATIVE_IMAGE_PROVIDER ('openai' | 'google' | 'mock')
 *   3. auto: openai when OPENAI_API_KEY is set, google when GEMINI_API_KEY is
 *      set, else the deterministic no-network mock.
 */

import type {
  AspectRatio,
  CreativeImageProvider,
  ProviderSize,
} from '@/lib/creative-engine/generation/types';
// `profiles/types` has zero runtime imports and the registry imports nothing
// from this module, so there is no cycle (and `profiles/` stays free of the
// providers' server graph).
import {
  ENV_GENERATION_PROFILE_ID,
  type GenerationProfile,
} from '@/lib/creative-engine/profiles/types';
import { createGoogleImageProvider } from './google-image';
import { createMockImageProvider, MOCK_IMAGE_MODEL } from './mock';
import { createOpenAIImageProvider } from './openai-image';
import {
  CREATIVE_IMAGE_PROVIDER_NAMES,
  isCreativeImageProviderName,
  readPinnedProviderName,
  resolveUnpinnedPoolNames,
  type CreativeImageProviderName,
} from './provider-names';

export {
  createGoogleImageProvider,
  createMockImageProvider,
  createOpenAIImageProvider,
  MOCK_IMAGE_MODEL,
};
export {
  CREATIVE_IMAGE_PROVIDER_NAMES,
  isCreativeImageProviderName,
  type CreativeImageProviderName,
} from './provider-names';

type ProviderFactory = (_opts?: { model?: string }) => CreativeImageProvider;

// Keyed by the closed name union: a factory without a name (or a name without
// a factory) fails typecheck.
const PROVIDER_FACTORIES: Record<CreativeImageProviderName, ProviderFactory> = {
  openai: createOpenAIImageProvider,
  google: createGoogleImageProvider,
  mock: createMockImageProvider,
};

/**
 * Resolve one provider by name (or by env/auto-detection when omitted).
 * Throws on an unknown explicit/env name — a typo must not silently fall back
 * to a paid default.
 */
export function getCreativeImageProvider(name?: string): CreativeImageProvider {
  const requested = (name ?? process.env.CREATIVE_IMAGE_PROVIDER ?? '').trim().toLowerCase();
  if (requested) {
    if (!isCreativeImageProviderName(requested)) {
      throw new Error(
        `Unknown creative image provider "${requested}". Available: ${CREATIVE_IMAGE_PROVIDER_NAMES.join(', ')}.`
      );
    }
    return PROVIDER_FACTORIES[requested]();
  }
  if (process.env.OPENAI_API_KEY) return createOpenAIImageProvider();
  if (process.env.GEMINI_API_KEY) return createGoogleImageProvider();
  return createMockImageProvider();
}

/** The profile fields the pool builder reads (a plain selector — no registry import). */
export type ProviderPoolProfile = Pick<GenerationProfile, 'id' | 'image' | 'imagePoolMixed'>;

/**
 * Default provider pool for a generation run. A pinned CREATIVE_IMAGE_PROVIDER
 * yields exactly that provider; otherwise every keyed provider participates
 * (the pipeline fans candidates out round-robin), falling back to the mock
 * when no keys are configured.
 *
 * With a generation profile: the implicit `env` profile (or any profile whose
 * image pool is mixed) takes the env path above BYTE-FOR-BYTE; a named
 * profile yields exactly ONE provider — its image provider, carrying the
 * profile's model override.
 */
export function resolveDefaultProviders(
  profile?: ProviderPoolProfile
): CreativeImageProvider[] {
  if (profile && profile.id !== ENV_GENERATION_PROFILE_ID && !profile.imagePoolMixed) {
    return [PROVIDER_FACTORIES[profile.image.provider]({ model: profile.image.model })];
  }

  const pinned = readPinnedProviderName();
  if (pinned) return [getCreativeImageProvider(pinned)];

  return resolveUnpinnedPoolNames().map((name) => PROVIDER_FACTORIES[name]());
}

const ASPECT_RATIO_DIMENSIONS: Record<AspectRatio, ProviderSize> = {
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 1024, height: 1280 },
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
};

/** Canonical pixel dimensions per supported aspect ratio (providers may snap). */
export function dimensionsForAspectRatio(ratio: AspectRatio): ProviderSize {
  return ASPECT_RATIO_DIMENSIONS[ratio];
}

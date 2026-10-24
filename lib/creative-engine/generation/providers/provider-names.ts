/**
 * The closed set of creative image provider names, plus the env-driven
 * default-pool NAME resolution — in a zero-import module.
 *
 * `./index.ts` types its factory table as `Record<CreativeImageProviderName, …>`,
 * so adding a factory without adding its name here (or vice versa) fails
 * `npm run typecheck`. The generation-profile registry
 * (`lib/creative-engine/profiles/`, client-safe) validates named profiles
 * against this list and derives the env profile from
 * `resolveDefaultProviderNames()` without importing the provider modules
 * (whose usage metering pulls `node:async_hooks`).
 *
 * All env reads happen inside the functions, never at import time.
 */

export const CREATIVE_IMAGE_PROVIDER_NAMES = ['openai', 'google', 'mock'] as const;

export type CreativeImageProviderName = (typeof CREATIVE_IMAGE_PROVIDER_NAMES)[number];

export function isCreativeImageProviderName(
  value: unknown
): value is CreativeImageProviderName {
  return (
    typeof value === 'string' &&
    (CREATIVE_IMAGE_PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

/** The API key env var each provider needs to make a LIVE call (mock needs none). */
export const PROVIDER_API_KEY_ENV: Record<CreativeImageProviderName, string | null> = {
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  mock: null,
};

/** `CREATIVE_IMAGE_PROVIDER`, trimmed + lowercased; '' when unset. */
export function readPinnedProviderName(): string {
  return (process.env.CREATIVE_IMAGE_PROVIDER ?? '').trim().toLowerCase();
}

/**
 * The provider names of the default (env) pool, in fan-out order — the SAME
 * precedence `resolveDefaultProviders()` builds its pool with: every keyed
 * provider (openai first, then google), else the mock. Only meaningful when
 * `CREATIVE_IMAGE_PROVIDER` is NOT pinned; a pinned name is a pool of one.
 */
export function resolveUnpinnedPoolNames(): CreativeImageProviderName[] {
  const names: CreativeImageProviderName[] = [];
  if (process.env.OPENAI_API_KEY) names.push('openai');
  if (process.env.GEMINI_API_KEY) names.push('google');
  if (names.length === 0) names.push('mock');
  return names;
}

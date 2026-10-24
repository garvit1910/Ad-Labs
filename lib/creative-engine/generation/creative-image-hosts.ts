/**
 * Where creative-generation images may be read from (security audit
 * 2026-10-20, M8): https on an Adcero asset host. Zero imports so request
 * schemas (and any client form) can validate a brand-kit URL with the SAME
 * list `safe-image-fetch.ts` enforces at fetch time.
 */

/** Hosts every environment serves creative images from. */
const BASE_CREATIVE_IMAGE_HOSTS = ['assets.adcero.io', 'logos.adcero.io', 'adcero.io'];

/** Env-configured public bucket origins (dev/preview buckets live here). */
const CREATIVE_IMAGE_HOST_ENV_KEYS = [
  'NEXT_PUBLIC_R2_AD_CREATIVES_URL',
  'R2_AD_CREATIVES_URL',
  'NEXT_PUBLIC_R2_PUBLIC_BUCKET_URL',
  'R2_PUBLIC_BUCKET_URL',
  'NEXT_PUBLIC_R2_PAGE_LOGOS_URL',
  'R2_PAGE_LOGOS_URL',
] as const;

export function creativeImageAllowedHosts(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const hosts = new Set(BASE_CREATIVE_IMAGE_HOSTS);
  for (const key of CREATIVE_IMAGE_HOST_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      const { protocol, hostname } = new URL(value);
      if (protocol === 'https:') hosts.add(hostname.toLowerCase());
    } catch {
      // A malformed env value adds nothing; it never widens the list.
    }
  }
  return [...hosts];
}

/**
 * Synchronous shape check for write-time validation (brand-kit PUT, product
 * image delta, briefs): https and an allowlisted host. The fetch re-checks it
 * and resolves DNS, so this is the early, user-facing refusal, not the guard.
 */
export function isAllowedCreativeImageUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && creativeImageAllowedHosts().includes(hostname.toLowerCase());
  } catch {
    return false;
  }
}

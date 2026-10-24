import { ApifyAdLibraryProvider } from './apify-provider';
import { GoogleApifyAdLibraryProvider } from './google-apify-provider';
import { AdLibraryProvider } from './types';

export * from './types';
export { ApifyAdLibraryProvider } from './apify-provider';
export { GoogleApifyAdLibraryProvider } from './google-apify-provider';

export type AdLibraryPlatform = 'meta' | 'google';

/**
 * Provider selection, branched by the competitor's platform. Ad Lab keeps only
 * the Apify providers (REUSE_MANIFEST §8.3): Meta via the public Ad Library
 * actor, Google via the Transparency Center actor. Both throw
 * `APIFY_TOKEN is not configured` when the token is missing.
 */
export function getAdLibraryProvider(
  platform: AdLibraryPlatform = 'meta'
): AdLibraryProvider {
  return platform === 'google'
    ? new GoogleApifyAdLibraryProvider()
    : new ApifyAdLibraryProvider();
}

/**
 * The ONE way creative generation reads an image URL (security audit
 * 2026-10-20, M8).
 *
 * Brand-kit logos, product reference images, edit sources and judge inputs are
 * URLs that came from a request body (`BrandKitSchema`, briefs, the product
 * image delta). Before this module the OpenAI/Gemini providers and the judge
 * fetched them with a bare `fetch`: redirects followed, no private-address
 * block, so a brand kit naming `http://169.254.169.254/...` made the server
 * fetch it, and the status code surfaced in the run's error text.
 *
 * Every remote URL now has to be https on an Adcero asset host (R2 public
 * buckets + adcero.io), passes `validateSafeRemoteUrl` (DNS pinned, private and
 * reserved ranges refused, IPv6 embeddings included) and is fetched with
 * redirects refused, a size cap and an image content type. `data:` URLs (fresh
 * candidate bytes) are decoded locally and never touch the network.
 *
 * Server-only (undici, node:dns).
 */
import {
  fetchPinnedRemoteResponse,
  isRedirectResponse,
  normalizeRemoteContentType,
  readResponseBufferWithLimit,
  validateSafeRemoteUrl,
} from '@/lib/video-fetch-utils';
import { creativeImageAllowedHosts, isAllowedCreativeImageUrl } from './creative-image-hosts';

export { creativeImageAllowedHosts, isAllowedCreativeImageUrl };

export const CREATIVE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export class CreativeImageFetchError extends Error {
  readonly code: 'CREATIVE_IMAGE_URL_NOT_ALLOWED' | 'CREATIVE_IMAGE_FETCH_FAILED';
  constructor(code: CreativeImageFetchError['code'], message: string) {
    super(message);
    this.name = 'CreativeImageFetchError';
    this.code = code;
  }
}

export interface FetchedCreativeImage {
  buffer: Buffer;
  contentType: string;
}

function decodeDataUrl(url: string, maxBytes: number, label: string): FetchedCreativeImage {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(url);
  if (!match) {
    throw new CreativeImageFetchError('CREATIVE_IMAGE_URL_NOT_ALLOWED', `${label} is not a base64 image data URL.`);
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw new CreativeImageFetchError('CREATIVE_IMAGE_FETCH_FAILED', `${label} is empty or too large.`);
  }
  return { buffer, contentType: match[1].toLowerCase() };
}

export async function fetchCreativeImage(
  url: string,
  options: { signal?: AbortSignal; maxBytes?: number; label?: string } = {},
): Promise<FetchedCreativeImage> {
  const label = options.label ?? 'image';
  const maxBytes = options.maxBytes ?? CREATIVE_IMAGE_MAX_BYTES;
  if (url.startsWith('data:')) return decodeDataUrl(url, maxBytes, label);

  if (!isAllowedCreativeImageUrl(url)) {
    throw new CreativeImageFetchError(
      'CREATIVE_IMAGE_URL_NOT_ALLOWED',
      `${label} must be an https URL on an Adcero asset host.`,
    );
  }
  const validation = await validateSafeRemoteUrl(url, {
    allowedProtocols: ['https:'],
    allowedHosts: creativeImageAllowedHosts(),
  });
  if (!validation.valid) {
    throw new CreativeImageFetchError('CREATIVE_IMAGE_URL_NOT_ALLOWED', `${label} URL was refused: ${validation.reason}.`);
  }

  const response = await fetchPinnedRemoteResponse(validation.parsed, validation.pinnedAddress, {
    signal: options.signal,
  });
  if (isRedirectResponse(response)) {
    throw new CreativeImageFetchError('CREATIVE_IMAGE_FETCH_FAILED', `Could not fetch ${label} (redirects are not followed).`);
  }
  if (!response.ok) {
    throw new CreativeImageFetchError('CREATIVE_IMAGE_FETCH_FAILED', `Could not fetch ${label} (${response.status}).`);
  }
  const contentType = normalizeRemoteContentType(response.headers.get('content-type'));
  if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') {
    throw new CreativeImageFetchError('CREATIVE_IMAGE_FETCH_FAILED', `${label} is not a raster image.`);
  }
  const buffer = Buffer.from(await readResponseBufferWithLimit(response, maxBytes));
  return { buffer, contentType };
}

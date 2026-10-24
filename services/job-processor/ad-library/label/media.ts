import type {
  AspectRatio,
  DurationBucket,
} from '@/services/ad-library/label-taxonomy';
import type { AdToLabel } from './types';

/**
 * Number of distinct creative cards, from the stored media arrays. media_urls
 * holds one still per card (image or video poster) and video_urls one mp4 per
 * video card, so the larger count is the card total. A `carousel_listicle`
 * needs 2+ cards — a single-media ad (one image or one video) cannot be one,
 * regardless of what the LLM guesses. See `parseLabelItem`.
 */
export function cardCount(ad: {
  media_urls: string[] | null;
  video_urls: string[] | null;
}): number {
  return Math.max(ad.media_urls?.length ?? 0, ad.video_urls?.length ?? 0);
}

/**
 * Number of STATIC image cards: total per-card stills (`media_urls` holds one
 * per card) minus video cards (`video_urls` holds one mp4 per video card). A
 * `carousel_product_set`/`carousel_listicle` is a set of static product/list
 * IMAGES, so only these count toward carousel eligibility — a carousel whose
 * cards are videos is video content, not a product set (a founder/UGC video
 * carousel was mislabeled `carousel_product_set` because a plain 2-card guard
 * let it through). See `parseLabelItem`'s carousel guard and `isVideoCardCarousel`.
 */
export function staticImageCardCount(ad: {
  media_urls: string[] | null;
  video_urls: string[] | null;
}): number {
  return Math.max(
    0,
    (ad.media_urls?.length ?? 0) - (ad.video_urls?.length ?? 0)
  );
}

/**
 * A carousel whose cards are ALL videos (every card backed by an mp4). These
 * take the full Gemini video pass on the lead card — like a single video ad —
 * instead of the static-poster path, so the format is judged from the moving
 * creative (founder_talking, ugc, ...) rather than defaulting to a carousel
 * bucket. Requires 2+ cards all backed by video (`video_urls` is nonEmpty-
 * collapsed, so `>= media_urls` means no static-image card is present).
 */
export function isVideoCardCarousel(ad: {
  media_type: string | null;
  media_urls: string[] | null;
  video_urls: string[] | null;
}): boolean {
  const videos = ad.video_urls?.length ?? 0;
  return (
    ad.media_type === 'carousel' &&
    videos >= 2 &&
    videos >= (ad.media_urls?.length ?? 0)
  );
}

/**
 * Buckets creative dimensions into the coarse ASPECT_RATIOS taxonomy. The
 * poster's dimensions stand in for the creative's (the poster IS the image, or
 * the video's frame).
 */
export function aspectRatioFromDims(
  width: number,
  height: number
): AspectRatio | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const ratio = width / height;
  const buckets: Array<[AspectRatio, number]> = [
    ['9:16', 9 / 16],
    ['4:5', 4 / 5],
    ['1:1', 1],
    ['16:9', 16 / 9],
  ];
  for (const [bucket, target] of buckets) {
    if (Math.abs(ratio - target) / target <= 0.05) return bucket;
  }
  return 'other';
}

/** Buckets a video duration (seconds) into the coarse DURATION_BUCKETS taxonomy. */
export function durationBucketFromSeconds(seconds: number): DurationBucket {
  if (seconds < 15) return 'lt15';
  if (seconds <= 30) return '15_30';
  if (seconds <= 60) return '30_60';
  return 'gt60';
}

/**
 * Resolves the deterministic duration bucket for a video ad. A MEASURED length
 * (from the fetched mp4's mvhd box) beats the LLM. When we couldn't measure it
 * (YouTube — no bytes), fall back to the model's numeric `duration_seconds`
 * estimate if present and finite. Returns null when neither is available.
 */
export function resolveDurationBucket(
  videoPart: { durationSeconds?: number | null },
  llmItem: unknown
): DurationBucket | null {
  const measured = videoPart.durationSeconds;
  if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) {
    return durationBucketFromSeconds(measured);
  }
  const estimate =
    llmItem && typeof llmItem === 'object'
      ? (llmItem as Record<string, unknown>).duration_seconds
      : undefined;
  if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0) {
    return durationBucketFromSeconds(estimate);
  }
  return null;
}

/**
 * Detects the image format from its leading bytes and returns the MIME type,
 * but only for the formats the OpenAI vision input accepts (png, jpeg, gif,
 * webp). Anything else — AVIF, HEIC, SVG, BMP, or bytes that don't match the
 * served `content-type` — returns null. The CDN's `content-type` header is not
 * trusted: one AVIF poster served as `image/*` made OpenAI reject the whole
 * labelling request with 400 `invalid_image_format`, and the same batch failed
 * on every re-queue (prod 2026-10-09 and 2026-10-10).
 */
export function sniffVisionImageMime(buffer: Uint8Array): string | null {
  const startsWith = (bytes: number[], offset = 0) =>
    buffer.length >= offset + bytes.length &&
    bytes.every((byte, i) => buffer[offset + i] === byte);

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return 'image/gif';
  }
  // RIFF....WEBP
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

export interface FetchedPoster {
  dataUrl: string;
  aspectRatio: AspectRatio | null;
}

/**
 * Downloads a creative poster frame and returns it as a base64 data URL (for
 * the vision label call) plus its aspect-ratio bucket, or null on any failure
 * (dead CDN link, non-image response, oversize, timeout). Callers treat null as
 * "label this ad text-only" — a stale Meta scontent URL must degrade one ad's
 * input, never fail the batch (sending the raw URL to OpenAI instead would
 * abort the whole request on a dead link). Dimension probing failures degrade
 * to aspectRatio null, never to a lost poster.
 */
export async function fetchPoster(
  url: string,
  timeoutMs = 10_000
): Promise<FetchedPoster | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > 4 * 1024 * 1024) return null;
    // A format the vision model rejects degrades this ad to text-only instead
    // of failing the whole labelling request.
    const mime = sniffVisionImageMime(buffer);
    if (!mime) return null;

    let aspectRatio: AspectRatio | null = null;
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(buffer).metadata();
      if (meta.width && meta.height) {
        aspectRatio = aspectRatioFromDims(meta.width, meta.height);
      }
    } catch {
      // Dimension probing is best-effort; the poster itself is still usable.
    }

    return {
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      aspectRatio,
    };
  } catch {
    return null;
  }
}

/** Back-compat helper: just the poster data URL. */
export async function fetchPosterDataUrl(
  url: string,
  timeoutMs = 10_000
): Promise<string | null> {
  const poster = await fetchPoster(url, timeoutMs);
  return poster?.dataUrl ?? null;
}

/** First stored media URL (the poster frame for videos, the image otherwise). */
export function posterUrl(ad: Pick<AdToLabel, 'media_urls'>): string | null {
  const url = ad.media_urls?.[0];
  return url && /^https?:\/\//.test(url) ? url : null;
}

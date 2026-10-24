/**
 * Video ingestion for the ad-label fingerprint pass. Turns a stored
 * `library_ads.video_urls[0]` into a Gemini content part:
 *
 * - YouTube URLs (Google Transparency Center ads) → `fileData.fileUri`;
 *   Gemini ingests YouTube natively, no download.
 * - fbcdn/https mp4s (Meta ads) → downloaded with a bounded timeout and
 *   inlined as base64. Inline requests cap around 20MB, so anything over
 *   MAX_INLINE_VIDEO_BYTES falls back to null (the caller degrades that ad
 *   to the poster-frame path). A dead CDN link must never fail the batch.
 *
 * Cost note: Gemini bills video at ~258 tokens/sec of footage + ~32/sec audio
 * (≈$0.003 for a 30s ad on gemini-2.5-flash) — trivial per ad, so no budget
 * gate here; volume is transitively bounded by the sync-enqueue cap.
 */

// Just under Gemini's ~20MB inline-request ceiling, leaving headroom for the
// prompt + schema around the base64 payload.
export const MAX_INLINE_VIDEO_BYTES = 18 * 1024 * 1024;

const VIDEO_FETCH_TIMEOUT_MS = 30_000;

export interface GeminiVideoPart {
  fileData?: { fileUri: string };
  inlineData?: { mimeType: string; data: string };
  /**
   * Deterministic video length in seconds, parsed from the mp4's mvhd box when
   * the bytes are in hand (inline branch). Undefined for the YouTube branch (no
   * download) — the caller then falls back to the LLM's estimate.
   */
  durationSeconds?: number | null;
}

/**
 * Parses a video's duration (seconds) from an mp4 buffer by walking the
 * top-level boxes to `moov`, then the `mvhd` box inside it (timescale/duration).
 * Version 0: timescale u32 @ mvhd+12, duration u32 @ +16. Version 1: timescale
 * u32 @ +20, duration u64 @ +24. Returns null on any parse failure — never
 * throws (a malformed/truncated download must degrade to "unmeasured").
 */
export function parseMp4DurationSeconds(buffer: Buffer): number | null {
  try {
    // Find the top-level moov box.
    let moovStart = -1;
    let moovEnd = -1;
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      // size 0 → box extends to EOF; size 1 → 64-bit largesize follows (rare for
      // top-level boxes here) — bail rather than mis-walk.
      if (size === 1 || size === 0) {
        if (type === 'moov') {
          moovStart = offset + 8;
          moovEnd = buffer.length;
          break;
        }
        return null;
      }
      if (size < 8) return null;
      if (type === 'moov') {
        moovStart = offset + 8;
        moovEnd = Math.min(offset + size, buffer.length);
        break;
      }
      offset += size;
    }
    if (moovStart < 0) return null;

    // Find mvhd within moov.
    let inner = moovStart;
    while (inner + 8 <= moovEnd) {
      const size = buffer.readUInt32BE(inner);
      const type = buffer.toString('ascii', inner + 4, inner + 8);
      if (type === 'mvhd') {
        const box = inner + 8;
        const version = buffer.readUInt8(box);
        if (version === 1) {
          if (box + 32 > buffer.length) return null;
          const timescale = buffer.readUInt32BE(box + 20);
          const duration = Number(buffer.readBigUInt64BE(box + 24));
          if (!timescale) return null;
          return duration / timescale;
        }
        if (box + 20 > buffer.length) return null;
        const timescale = buffer.readUInt32BE(box + 12);
        const duration = buffer.readUInt32BE(box + 16);
        if (!timescale) return null;
        return duration / timescale;
      }
      if (size < 8) return null;
      inner += size;
    }
    return null;
  } catch {
    return null;
  }
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com';
  } catch {
    return false;
  }
}

/**
 * Returns a Gemini content part for the ad's video, or null when the video is
 * unavailable, oversized, or not actually a video — callers treat null as
 * "use the poster frame instead".
 */
export async function fetchVideoPart(
  url: string,
  timeoutMs = VIDEO_FETCH_TIMEOUT_MS
): Promise<GeminiVideoPart | null> {
  if (!/^https?:\/\//.test(url)) return null;
  if (isYouTubeUrl(url)) return { fileData: { fileUri: url } };

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!contentType.startsWith('video/')) return null;

    // Cheap pre-check when the CDN declares a length; the buffer check below
    // still guards chunked responses.
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_INLINE_VIDEO_BYTES) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_INLINE_VIDEO_BYTES) return null;
    return {
      inlineData: { mimeType: contentType, data: buffer.toString('base64') },
      durationSeconds: parseMp4DurationSeconds(buffer),
    };
  } catch {
    return null;
  }
}

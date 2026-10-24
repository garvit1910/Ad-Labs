import { extractLandingDomain } from './landing-domain';
import type { AdLibraryMediaType, AdSpendRange, NormalizedAd } from './types';

/**
 * Maps one raw item from the curious_coder/facebook-ads-library-scraper actor
 * to the canonical NormalizedAd shape the sync job upserts. Field names were
 * captured from a real run (see scripts/ad-library/apify-probe.ts) — the actor
 * nests creative text/media under `snapshot`, dates are unix seconds, and an
 * explicit `is_active` flag drives delivery_stop (longevity is derived in SQL).
 */

interface ApifyVideo {
  video_hd_url?: string | null;
  video_sd_url?: string | null;
  video_preview_image_url?: string | null;
}

interface ApifyImage {
  original_image_url?: string | null;
  resized_image_url?: string | null;
}

interface ApifyCard {
  body?: string | null;
  title?: string | null;
  link_url?: string | null;
  link_description?: string | null;
  original_image_url?: string | null;
  resized_image_url?: string | null;
  video_hd_url?: string | null;
  video_sd_url?: string | null;
  video_preview_image_url?: string | null;
}

interface ApifySnapshot {
  body?: { text?: string | null } | string | null;
  title?: string | null;
  caption?: string | null;
  link_description?: string | null;
  link_url?: string | null;
  display_format?: string | null;
  images?: ApifyImage[] | null;
  videos?: ApifyVideo[] | null;
  cards?: ApifyCard[] | null;
  page_name?: string | null;
}

export interface ApifyAdItem {
  ad_archive_id?: string | number | null;
  ad_id?: string | number | null;
  ad_library_url?: string | null;
  page_id?: string | number | null;
  page_name?: string | null;
  publisher_platform?: string[] | null;
  currency?: string | null;
  spend?: { lower_bound?: number | string; upper_bound?: number | string } | null;
  reach_estimate?: number | null;
  is_active?: boolean | null;
  start_date?: number | null;
  end_date?: number | null;
  start_date_formatted?: string | null;
  end_date_formatted?: string | null;
  transparency_by_location?: {
    eu_transparency?: { eu_total_reach?: number | null } | null;
  } | null;
  snapshot?: ApifySnapshot | null;
  error?: string;
}

function unixSecondsToIso(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function bodyText(
  body: ApifySnapshot['body']
): string | null {
  if (!body) return null;
  if (typeof body === 'string') return body.trim() || null;
  return body.text?.trim() || null;
}

function nonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * True when `snapshot.cards` are placement / aspect-ratio renditions of ONE
 * creative (Meta Dynamic Creative Optimization), NOT a swipeable multi-card
 * carousel. Verified across a full scrape page: every multi-card item was a DCO
 * variant set carrying `display_format "DCO"` AND identical per-card
 * link_url/body/title, while genuine carousels/DPA carry distinct per-card copy
 * and links.
 *
 * - `DCO` is Meta's own dynamic-creative flag → variant set.
 * - An explicit `CAROUSEL`/`DPA` format is a genuine carousel → not a variant.
 * - Otherwise (blank/`VIDEO`/unknown format, which the actor emits for both),
 *   fall back to content: every card repeating the SAME NON-EMPTY link+body+title
 *   means one creative in several crops. The non-empty guard keeps a bare
 *   copy-less multi-card carousel (a real carousel) from collapsing.
 */
function isVariantCardSet(snapshot: ApifySnapshot): boolean {
  const cards = snapshot.cards ?? [];
  if (cards.length < 2) return false;
  const format = (snapshot.display_format ?? '').toUpperCase();
  if (format === 'DCO') return true;
  if (format === 'CAROUSEL' || format === 'DPA') return false;
  const link = cards[0].link_url?.trim() ?? '';
  const body = cards[0].body?.trim() ?? '';
  const title = cards[0].title?.trim() ?? '';
  if (!link && !body) return false;
  return cards.every(
    (c) =>
      (c.link_url?.trim() ?? '') === link &&
      (c.body?.trim() ?? '') === body &&
      (c.title?.trim() ?? '') === title
  );
}

/** The cards that represent distinct media: a variant set collapses to its lead card. */
function distinctMediaCards(snapshot: ApifySnapshot): ApifyCard[] {
  const cards = snapshot.cards ?? [];
  return isVariantCardSet(snapshot) ? cards.slice(0, 1) : cards;
}

function deriveMediaType(snapshot: ApifySnapshot): AdLibraryMediaType {
  const cards = snapshot.cards ?? [];
  const videos = snapshot.videos ?? [];
  const images = snapshot.images ?? [];
  const format = (snapshot.display_format ?? '').toUpperCase();

  // A genuine multi-card creative (snapshot.cards) is a carousel regardless of
  // what display_format claims — the actor reports video-card carousels as
  // display_format "VIDEO", so trusting that first mistypes a swipeable ad as a
  // single video. But DCO / placement aspect-ratio variants ALSO arrive as
  // multiple cards, and those are ONE creative in several crops, not a carousel
  // (see isVariantCardSet). Only a genuine multi-card set counts as a carousel.
  if (cards.length > 1 && !isVariantCardSet(snapshot)) return 'carousel';

  if (format === 'VIDEO') return 'video';
  if (format === 'IMAGE') return 'image';
  if (format === 'CAROUSEL') return 'carousel';

  const hasVideo =
    videos.length > 0 || cards.some((c) => c.video_hd_url || c.video_sd_url);
  if (hasVideo) return 'video';
  if (images.length > 0 || cards.some((c) => c.original_image_url)) {
    return 'image';
  }
  return 'unknown';
}

/**
 * Still images for display/thumbnails. For video ads this is the poster frame
 * (video_preview_image_url) so an `<img>` thumbnail always renders — never the
 * mp4, which an `<img>` cannot display.
 */
function collectImageUrls(snapshot: ApifySnapshot): string[] {
  const urls: string[] = [];
  for (const v of snapshot.videos ?? []) {
    urls.push(v.video_preview_image_url ?? '');
  }
  for (const img of snapshot.images ?? []) {
    urls.push(img.original_image_url ?? img.resized_image_url ?? '');
  }
  // A DCO/aspect-ratio variant set collapses to its lead card so media_urls
  // holds one still per real card, not one per placement rendition.
  for (const c of distinctMediaCards(snapshot)) {
    urls.push(
      c.video_preview_image_url ??
        c.original_image_url ??
        c.resized_image_url ??
        ''
    );
  }
  return nonEmpty(urls);
}

/** Playable video URLs (mp4) for video and video-card ads. */
function collectVideoUrls(snapshot: ApifySnapshot): string[] {
  const urls: string[] = [];
  for (const v of snapshot.videos ?? []) {
    urls.push(v.video_hd_url ?? v.video_sd_url ?? '');
  }
  for (const c of distinctMediaCards(snapshot)) {
    urls.push(c.video_hd_url ?? c.video_sd_url ?? '');
  }
  return nonEmpty(urls);
}

function parseSpend(spend: ApifyAdItem['spend']): AdSpendRange | null {
  if (!spend) return null;
  const lower = Number(spend.lower_bound);
  if (!Number.isFinite(lower)) return null;
  const upper = Number(spend.upper_bound);
  return { lowerBound: lower, upperBound: Number.isFinite(upper) ? upper : null };
}

/** Returns null for items the actor could not scrape (no archive id). */
export function normalizeApifyAd(raw: ApifyAdItem): NormalizedAd | null {
  const externalAdId =
    raw.ad_archive_id != null
      ? String(raw.ad_archive_id)
      : raw.ad_id != null
        ? String(raw.ad_id)
        : null;
  const deliveryStart = unixSecondsToIso(raw.start_date);
  if (!externalAdId || !deliveryStart) return null;

  const snapshot = raw.snapshot ?? {};
  const cards = snapshot.cards ?? [];

  const isActive = raw.is_active === true;
  const euReach =
    raw.transparency_by_location?.eu_transparency?.eu_total_reach ??
    (typeof raw.reach_estimate === 'number' ? raw.reach_estimate : null);

  // Destination URL: snapshot-level first, else the lead card. The display
  // caption (e.g. "www.yesstyle.com") backs the domain when no URL exists.
  const landingUrl =
    snapshot.link_url?.trim() ||
    cards.find((c) => c.link_url?.trim())?.link_url?.trim() ||
    null;
  const landingDomain =
    extractLandingDomain(landingUrl) ?? extractLandingDomain(snapshot.caption);

  return {
    externalAdId,
    pageId: raw.page_id != null ? String(raw.page_id) : null,
    adSnapshotUrl:
      raw.ad_library_url ??
      `https://www.facebook.com/ads/library/?id=${externalAdId}`,
    creativeBodies: nonEmpty([
      bodyText(snapshot.body),
      ...cards.map((c) => c.body),
    ]),
    creativeLinkTitles: nonEmpty([
      snapshot.title,
      snapshot.link_description,
      ...cards.map((c) => c.title),
    ]),
    pageName: raw.page_name ?? snapshot.page_name ?? null,
    publisherPlatforms: (raw.publisher_platform ?? []).map((p) =>
      p.toLowerCase()
    ),
    deliveryStart,
    // Active ads have no real stop date; the SQL view derives longevity from
    // delivery_start → COALESCE(delivery_stop, now()).
    deliveryStop: isActive ? null : unixSecondsToIso(raw.end_date),
    euTotalReach: typeof euReach === 'number' ? euReach : null,
    currency: raw.currency?.trim() ? raw.currency.trim() : null,
    spendRange: parseSpend(raw.spend),
    mediaType: deriveMediaType(snapshot),
    mediaUrls: collectImageUrls(snapshot).length
      ? collectImageUrls(snapshot)
      : null,
    videoUrls: collectVideoUrls(snapshot).length
      ? collectVideoUrls(snapshot)
      : null,
    landingUrl,
    landingDomain,
  };
}

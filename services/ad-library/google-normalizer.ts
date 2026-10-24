import { extractLandingDomain } from './landing-domain';
import type { AdLibraryMediaType, NormalizedAd } from './types';

/**
 * Normalizes one item from the silva95gustavo/google-ads-scraper actor (Google
 * Ads Transparency Center) into the shared `NormalizedAd` shape the sync job
 * upserts into `library_ads` (with platform='google').
 *
 * Two Google-specific decisions live here:
 *  - Active-state inference. The actor's `lastShown` is *always* populated, even
 *    for a still-running ad, so a naive delivery_stop=lastShown would make every
 *    Google ad read inactive. Instead lastShown within STALE_DAYS of the sync is
 *    treated as still running (delivery_stop=null); older means ended.
 *  - Text comes from `variations[].{description,cta}` (+ the actor's `ocr`
 *    option), which exists for IMAGE ads too — not just TEXT ads.
 */

/** lastShown within this many days of the sync ⇒ still running. Covers the
 *  documented 48–72h delay between an ad serving and appearing in the Center. */
export const GOOGLE_ACTIVE_STALE_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GoogleAdVariation {
  clickUrl?: string | null;
  cta?: string | null;
  description?: string | null;
  headline?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
}

/** The actor's per-ad output. Optional everywhere — the actor omits fields. */
export interface GoogleAdItem {
  creativeId?: string | null;
  advertiserId?: string | null;
  advertiserName?: string | null;
  format?: string | null;
  /** Full ISO 8601 timestamp (e.g. "2025-07-10T07:21:24.351Z"). */
  firstShown?: string | null;
  /** Full ISO 8601 timestamp; the last instant the ad was observed serving. */
  lastShown?: string | null;
  numServedDays?: number | null;
  previewUrl?: string | null;
  adLibraryUrl?: string | null;
  variations?: GoogleAdVariation[] | null;
  videoUrls?: string[] | null;
  // Defensive: some actor versions surface copy at the item level.
  description?: string | null;
  headline?: string | null;
}

function mapMediaType(format: string | null | undefined): AdLibraryMediaType {
  switch ((format ?? '').toUpperCase()) {
    case 'TEXT':
      return 'text';
    case 'IMAGE':
      return 'image';
    case 'VIDEO':
      return 'video';
    default:
      return 'unknown';
  }
}

/**
 * Parses the actor's date fields — full ISO 8601 timestamps (e.g.
 * "2025-07-10T07:21:24.351Z") or a bare "YYYY-MM-DD" — to ISO, or null for
 * anything unparseable.
 */
function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function normalizeGoogleAd(
  item: GoogleAdItem,
  opts: { now: Date }
): NormalizedAd | null {
  const externalAdId = item.creativeId?.trim();
  const deliveryStart = toIsoOrNull(item.firstShown);
  // Drop anything we can't key or place on the timeline (mirrors the Meta
  // normalizer dropping ads with no id / no delivery_start).
  if (!externalAdId || !deliveryStart) return null;

  const variations = item.variations ?? [];

  // Ad copy: variation descriptions/headlines as bodies, CTAs as link titles,
  // plus any item-level copy the actor surfaced.
  const creativeBodies = uniqueNonEmpty([
    item.description,
    item.headline,
    ...variations.map((v) => v.description),
    ...variations.map((v) => v.headline),
  ]);
  const creativeLinkTitles = uniqueNonEmpty(variations.map((v) => v.cta));

  // Destination URL — the first non-empty variation clickUrl.
  const landingUrl =
    variations.find((v) => v.clickUrl?.trim())?.clickUrl?.trim() || null;

  const mediaUrls = uniqueNonEmpty([
    item.previewUrl,
    ...variations.map((v) => v.imageUrl),
  ]);
  const videoUrls = uniqueNonEmpty([
    ...(item.videoUrls ?? []),
    ...variations.map((v) => v.videoUrl),
  ]);

  // Active-state inference (see file header). lastShown is the last instant the
  // ad was observed serving; recent ⇒ still running (delivery_stop=null).
  let deliveryStop: string | null = null;
  const lastShownMs = item.lastShown ? Date.parse(item.lastShown) : Number.NaN;
  if (
    !Number.isNaN(lastShownMs) &&
    opts.now.getTime() - lastShownMs > GOOGLE_ACTIVE_STALE_DAYS * DAY_MS
  ) {
    deliveryStop = new Date(lastShownMs).toISOString();
  }

  return {
    externalAdId,
    // Advertiser identity → backfills the competitor's resolved id/name.
    pageId: item.advertiserId?.trim() || null,
    pageName: item.advertiserName?.trim() || null,
    adSnapshotUrl: item.adLibraryUrl?.trim() || null,
    creativeBodies,
    creativeLinkTitles,
    // Google has no Facebook/Instagram-style placements.
    publisherPlatforms: [],
    deliveryStart,
    deliveryStop,
    // The Transparency Center exposes no spend/reach for commercial ads, so
    // these stay null and Google rows fall into the win-score non-EU branch.
    euTotalReach: null,
    currency: null,
    spendRange: null,
    mediaType: mapMediaType(item.format),
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : null,
    videoUrls: videoUrls.length > 0 ? videoUrls : null,
    // The actor's own served-day count — the longevity basis for Google win
    // scoring. Clamp to a non-negative integer; null when the actor omits it.
    numServedDays:
      typeof item.numServedDays === 'number' && Number.isFinite(item.numServedDays)
        ? Math.max(0, Math.round(item.numServedDays))
        : null,
    landingUrl,
    landingDomain: extractLandingDomain(landingUrl),
  };
}

/**
 * Competitor landing pages: which destination URLs a competitor's ads send
 * traffic to, ranked deterministically from data already on the enriched rows
 * (`landing_url`, `is_active`, `longevity_days`, the LLM labels). Zero LLM,
 * zero fetches — page-content analysis is a later phase.
 *
 * Pure and client-safe: no DB, no app/ imports. The winner test is injected
 * (`isWinner`) so callers classify through the route's ONE evaluator rather
 * than a second one built here.
 */
import { median } from './math';
import type { EnrichedAdRow } from './types';
import {
  isTrackerDomain,
  unwrapRedirectUrl,
} from '@/services/ad-library/landing-domain';

/** Default number of ranked pages returned. */
export const LANDING_PAGES_DEFAULT_LIMIT = 12;
/** Chips per label facet (angles / offers / hooks / formats). */
const TOP_LABELS = 3;
/** Representative ads per page. */
const SAMPLE_ADS = 3;

/**
 * Query params that only identify the click, never the destination. Dropped
 * before keying so the same page reached from two campaigns is one entry.
 * `utm_*` is matched by prefix.
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'ttclid',
  'msclkid',
  'ref',
  'mc_cid',
  'mc_eid',
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

/**
 * Resolves a scraped landing URL to the destination it points at: unwraps
 * tracker/redirect wrappers (`googleadservices.com/...?adurl=`, `l.facebook.com/l.php?u=`)
 * and rejects a tracker/link-hub host that survived unwrapping (it identifies
 * no brand page). Shared with the `dedicated_landing` scaling signal so both
 * read a landing URL the same way. Null when unparseable.
 */
export function parseLandingDestination(
  url: string | null | undefined
): URL | null {
  if (!url) return null;
  try {
    const parsed = new URL(unwrapRedirectUrl(url.trim()));
    if (isTrackerDomain(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface NormalizedLandingUrl {
  /** Grouping key: host + path + sorted non-tracking query. */
  key: string;
  /** Clean, clickable URL (original protocol, tracking params dropped). */
  url: string;
  /** Lowercased host as written (a `www.` prefix is kept). */
  domain: string;
  /** Path with trailing slashes stripped; `/` for the root. Case preserved. */
  path: string;
  /** True when the path is the site root (`/`). */
  isRoot: boolean;
}

/**
 * Normalizes a landing URL for grouping: lowercase host (kept otherwise as-is,
 * including `www.`), tracking params dropped, hash dropped, trailing slashes
 * dropped, remaining query params sorted. Path case is preserved — URL paths
 * are case-sensitive. Null for empty, unparseable, non-http(s), or tracker-only
 * URLs.
 */
export function normalizeLandingUrl(
  url: string | null | undefined
): NormalizedLandingUrl | null {
  const parsed = parseLandingDestination(url);
  if (!parsed) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const domain = parsed.host.toLowerCase();
  if (!domain) return null;

  const stripped = parsed.pathname.replace(/\/+$/, '');
  const path = stripped === '' ? '/' : stripped;

  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([aName, aValue], [bName, bValue]) =>
      aName === bName
        ? aValue < bValue
          ? -1
          : aValue > bValue
            ? 1
            : 0
        : aName < bName
          ? -1
          : 1
    );
  const query = params.length > 0 ? `?${new URLSearchParams(params)}` : '';

  return {
    key: `${domain}${path}${query}`,
    url: `${parsed.protocol}//${domain}${path}${query}`,
    domain,
    path,
    isRoot: path === '/',
  };
}

export interface LabelCount {
  value: string;
  count: number;
}

export interface LandingPageEntry {
  key: string;
  url: string;
  domain: string;
  path: string;
  isRoot: boolean;
  adCount: number;
  activeAds: number;
  winnerCount: number;
  medianLongevityDays: number;
  maxLongevityDays: number;
  /** Earliest `first_seen_at` (library ingestion time — NOT a launch date). */
  firstSeenAt: string;
  /** Latest `last_seen_at`. */
  lastSeenAt: string;
  /** Distinct publisher platforms (facebook/instagram/…); the ad platform when none. */
  platforms: string[];
  /** Industry `angle`, falling back per row to `angle_universal`. */
  topAngles: LabelCount[];
  topOffers: LabelCount[];
  topHooks: LabelCount[];
  topFormats: LabelCount[];
  /** Up to 3 ad ids: winners first, then longest-running. */
  sampleAdIds: string[];
}

export interface LandingPagesSummary {
  /** Ads whose landing URL normalized to a page. */
  adsWithLanding: number;
  /** Ads with no (or no usable) landing URL — pre-capture rows land here. */
  adsWithoutLanding: number;
  distinctPages: number;
  pagesWithWinners: number;
  /** Share (0–1) of `adsWithLanding` pointing at a root page. */
  rootShare: number;
  /** Share (0–1) of `adsWithLanding` pointing at a non-root (dedicated) page. */
  dedicatedShare: number;
}

export interface LandingPagesResult {
  pages: LandingPageEntry[];
  summary: LandingPagesSummary;
}

export interface RankLandingPagesOptions {
  /** The caller's winner classifier — pass the route's single evaluator. */
  isWinner: (_row: EnrichedAdRow) => boolean;
  /** Max pages returned (default 12). Summary counts cover every page. */
  limit?: number;
  /**
   * Reserved for clock-dependent extensions. The ranking itself reads the
   * view-derived `is_active`/`longevity_days`, so no clock is consulted.
   */
  now?: Date;
}

/** Top-N label counts, count desc then value asc (deterministic). */
function topLabels(values: Array<string | null>, n = TOP_LABELS): LabelCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.value < b.value ? -1 : a.value > b.value ? 1 : 0
    )
    .slice(0, n);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ranks the destination pages a set of ads points at. Sort: winnerCount desc →
 * adCount desc → medianLongevityDays desc → key asc. Rows with no usable
 * landing URL count only in `summary.adsWithoutLanding`.
 */
export function rankLandingPages(
  rows: EnrichedAdRow[],
  opts: RankLandingPagesOptions
): LandingPagesResult {
  const limit = opts.limit ?? LANDING_PAGES_DEFAULT_LIMIT;
  const groups = new Map<
    string,
    { normalized: NormalizedLandingUrl; rows: EnrichedAdRow[]; winners: Set<string> }
  >();
  let adsWithoutLanding = 0;
  let rootAds = 0;

  for (const row of rows) {
    const normalized = normalizeLandingUrl(row.landing_url);
    if (!normalized) {
      adsWithoutLanding += 1;
      continue;
    }
    if (normalized.isRoot) rootAds += 1;
    const group = groups.get(normalized.key) ?? {
      normalized,
      rows: [],
      winners: new Set<string>(),
    };
    group.rows.push(row);
    if (opts.isWinner(row)) group.winners.add(row.id);
    groups.set(normalized.key, group);
  }

  const entries: LandingPageEntry[] = [...groups.values()].map(
    ({ normalized, rows: members, winners }) => {
      const longevities = members.map((row) => row.longevity_days ?? 0);
      const platforms = new Set<string>();
      for (const row of members) {
        const publishers = (row.publisher_platforms ?? []).filter(Boolean);
        if (publishers.length > 0) {
          for (const p of publishers) platforms.add(p.toLowerCase());
        } else if (row.platform) {
          platforms.add(row.platform);
        }
      }
      const samples = [...members]
        .sort((a, b) => {
          const aw = winners.has(a.id) ? 1 : 0;
          const bw = winners.has(b.id) ? 1 : 0;
          if (aw !== bw) return bw - aw;
          const longevity = (b.longevity_days ?? 0) - (a.longevity_days ?? 0);
          if (longevity !== 0) return longevity;
          return compareStrings(a.id, b.id);
        })
        .slice(0, SAMPLE_ADS)
        .map((row) => row.id);

      return {
        key: normalized.key,
        url: normalized.url,
        domain: normalized.domain,
        path: normalized.path,
        isRoot: normalized.isRoot,
        adCount: members.length,
        activeAds: members.filter((row) => row.is_active).length,
        winnerCount: winners.size,
        medianLongevityDays: median(longevities),
        maxLongevityDays: Math.max(...longevities),
        firstSeenAt: members
          .map((row) => row.first_seen_at)
          .reduce((min, value) => (value < min ? value : min)),
        lastSeenAt: members
          .map((row) => row.last_seen_at)
          .reduce((max, value) => (value > max ? value : max)),
        platforms: [...platforms].sort(),
        topAngles: topLabels(
          members.map((row) => row.angle ?? row.angle_universal ?? null)
        ),
        topOffers: topLabels(members.map((row) => row.offer_type)),
        topHooks: topLabels(members.map((row) => row.hook_archetype)),
        topFormats: topLabels(members.map((row) => row.format)),
        sampleAdIds: samples,
      };
    }
  );

  entries.sort((a, b) => {
    if (b.winnerCount !== a.winnerCount) return b.winnerCount - a.winnerCount;
    if (b.adCount !== a.adCount) return b.adCount - a.adCount;
    if (b.medianLongevityDays !== a.medianLongevityDays) {
      return b.medianLongevityDays - a.medianLongevityDays;
    }
    return compareStrings(a.key, b.key);
  });

  const adsWithLanding = rows.length - adsWithoutLanding;
  const rootShare = adsWithLanding > 0 ? rootAds / adsWithLanding : 0;
  return {
    pages: entries.slice(0, Math.max(0, limit)),
    summary: {
      adsWithLanding,
      adsWithoutLanding,
      distinctPages: entries.length,
      pagesWithWinners: entries.filter((entry) => entry.winnerCount > 0).length,
      rootShare,
      dedicatedShare: adsWithLanding > 0 ? (adsWithLanding - rootAds) / adsWithLanding : 0,
    },
  };
}

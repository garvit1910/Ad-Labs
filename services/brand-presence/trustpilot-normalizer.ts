/**
 * Defensive normalizer for memo23/trustpilot-scraper-ppe dataset items. Every
 * field name below was verified against a REAL probe run (2026-07-09,
 * nike.com/fiverr.com; see scratchpad/trustpilot-probe-findings.md). Unknown
 * shapes are skipped, never thrown — one malformed item must not kill an
 * ingest page.
 *
 * Trustpilot-specific quirks handled here:
 * - The review rating is the top-level `rating` (1–5 int); there is no
 *   `stars` key on the review item (unlike the Maps actor).
 * - `posted_at` comes from `dates.publishedDate` with a top-level
 *   `publishedDate` mirror as fallback.
 * - Reviews arrive multilingual; the title/body are stored as-is (the shared
 *   extractor joins `[title, body]`).
 * - `company.name.identifying` IS the exact unit slug and MAY include `www.`
 *   (e.g. `www.nike.com` — Trustpilot units are keyed by exact string;
 *   `www.x.com` and `x.com` are DIFFERENT units). Always normalize before the
 *   wrong-company comparison, always PRESERVE for targeting (`slug`), and
 *   `company.name.referring[]` lists alternate domains that also count as a
 *   match.
 * - The company block/star distribution ride on every item when
 *   includeCompanyDetails/includeStats are on (probe + refresh); the backfill
 *   runs turn them off, so extractCompanyFromItem returns null there.
 */
import { hashValue } from '@/lib/crypto/oauth-state';
import type { TrustpilotCandidate } from '@/lib/brand-presence/types';
import {
  normalizeDomain,
  parseTrustpilotUrl,
  sanitizeTrustpilotSlug,
  trustpilotUrlFromDomain,
} from '@/lib/brand-presence/trustpilot';

export interface NormalizedTrustpilotReview {
  /** The actor's review `id` — the idempotency key. */
  external_id: string;
  /** Review headline. */
  title: string | null;
  /** `text`; null for a title-only review. */
  body: string | null;
  /** 1–5 int from `rating`; null when out of range/absent. */
  rating: number | null;
  /** ISO timestamp from dates.publishedDate ?? publishedDate; null when bad. */
  posted_at: string | null;
  /** Review permalink; null → the processor falls back to the page URL. */
  url: string | null;
  /** sha256 of consumer.id ?? consumer.displayName ?? reviewerName — raw
   * identities are never stored; null when none survive. */
  author_ref: string | null;
  /** tags.trustpilot.verified — top-level isVerified === true. */
  verified: boolean;
  /** tags.trustpilot.country — consumer.countryCode ?? reviewerCountry. */
  country: string | null;
  /** tags.trustpilot.companyReplyText — reply.text ?? reply.message. */
  company_reply_text: string | null;
  /** tags.trustpilot.companyReplyAt — reply.publishedDate. */
  company_reply_at: string | null;
  /** tags.trustpilot.likes — likes ?? numberOfLikes. */
  likes: number | null;
}

export type NormalizedTrustpilotItem =
  | { kind: 'review'; review: NormalizedTrustpilotReview }
  | { kind: 'skipped'; reason: string };

/** The company block distilled for the resolve probe / refresh aggregates. */
export interface ExtractedTrustpilotCompany {
  /** company.name.identifying, normalized (www-stripped) — COMPARISON only. */
  domain: string | null;
  /** The EXACT unit slug for targeting (`www.` preserved): the actor's own
   * `businessUrl` slug, falling back to `name.identifying`. */
  slug: string | null;
  /** company.name.referring[], normalized — alternate domains that also match. */
  referringDomains: string[];
  /** company.displayName. */
  name: string | null;
  /** company.score.trustScore. */
  trustScore: number | null;
  /** company.numberOfReviews.total ?? stats.totalNumberOfReviews. */
  reviewsCount: number | null;
  /** company.numberOfReviews.{oneStar..} (fallback stats.ratings.{one..}). */
  starDistribution: Partial<Record<1 | 2 | 3 | 4 | 5, number>>;
  /** company.websiteUrl — the wrong-company/verified-domain source. */
  websiteUrl: string | null;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

/** Validates an integer 1..5 star rating (0/6/fractional → null). */
export function parseTrustpilotRating(value: unknown): number | null {
  const num = finiteNumber(value);
  return num !== null && Number.isInteger(num) && num >= 1 && num <= 5
    ? num
    : null;
}

export function parseReviewTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function normalizeTrustpilotReviewItem(
  raw: unknown,
): NormalizedTrustpilotItem {
  const item = asObject(raw);
  if (!item) {
    return { kind: 'skipped', reason: 'non-object item' };
  }
  // Defensive: pending rows are not live reviews yet.
  if (item.isPending === true) {
    return { kind: 'skipped', reason: 'pending review' };
  }

  const externalId = nonBlankString(item.id);
  if (!externalId) {
    return { kind: 'skipped', reason: 'missing id' };
  }

  const consumer = asObject(item.consumer) ?? {};
  const authorSource =
    nonBlankString(consumer.id) ??
    nonBlankString(consumer.displayName) ??
    nonBlankString(item.reviewerName);

  const dates = asObject(item.dates) ?? {};
  const reply = asObject(item.reply);

  return {
    kind: 'review',
    review: {
      external_id: externalId,
      title: nonBlankString(item.title),
      body: nonBlankString(item.text),
      rating: parseTrustpilotRating(item.rating),
      posted_at:
        parseReviewTimestamp(dates.publishedDate) ??
        parseReviewTimestamp(item.publishedDate),
      url: nonBlankString(item.url),
      author_ref: authorSource ? hashValue(authorSource) : null,
      verified: item.isVerified === true,
      country:
        nonBlankString(consumer.countryCode) ??
        nonBlankString(item.reviewerCountry),
      company_reply_text: reply
        ? (nonBlankString(reply.text) ?? nonBlankString(reply.message))
        : null,
      company_reply_at: reply
        ? parseReviewTimestamp(reply.publishedDate)
        : null,
      likes: finiteNumber(item.likes) ?? finiteNumber(item.numberOfLikes),
    },
  };
}

const STAR_KEYS: Array<[1 | 2 | 3 | 4 | 5, string, string]> = [
  [1, 'oneStar', 'one'],
  [2, 'twoStars', 'two'],
  [3, 'threeStars', 'three'],
  [4, 'fourStars', 'four'],
  [5, 'fiveStars', 'five'],
];

/**
 * Reads the company block (present with includeCompanyDetails) into the shape
 * the resolve probe / refresh aggregates need. Returns null when there is no
 * company signal at all (e.g. an enrichment-off backfill item).
 */
export function extractCompanyFromItem(
  raw: unknown,
): ExtractedTrustpilotCompany | null {
  const item = asObject(raw);
  if (!item) return null;
  const company = asObject(item.company);
  const stats = asObject(item.stats);
  if (!company && !stats) return null;

  const name = company ? asObject(company.name) : null;
  const domain = name ? normalizeDomain(String(name.identifying ?? '')) : null;
  // Exact unit slug for TARGETING (`www.` preserved): the item's own
  // businessUrl is the actor's canonical page URL; identifying is the fallback.
  const businessUrl = nonBlankString(item.businessUrl);
  const slug =
    (businessUrl ? parseTrustpilotUrl(businessUrl) : null) ??
    (name ? sanitizeTrustpilotSlug(String(name.identifying ?? '')) : null);
  const referringDomains: string[] = [];
  if (name && Array.isArray(name.referring)) {
    for (const entry of name.referring) {
      if (typeof entry !== 'string') continue;
      const normalized = normalizeDomain(entry);
      if (normalized && !referringDomains.includes(normalized)) {
        referringDomains.push(normalized);
      }
    }
  }

  const numberOfReviews = company ? asObject(company.numberOfReviews) : null;
  const statsRatings = stats ? asObject(stats.ratings) : null;
  const reviewsCount =
    finiteNumber(numberOfReviews?.total) ??
    finiteNumber(stats?.totalNumberOfReviews);

  const starDistribution: Partial<Record<1 | 2 | 3 | 4 | 5, number>> = {};
  for (const [star, companyKey, statsKey] of STAR_KEYS) {
    const value =
      finiteNumber(numberOfReviews?.[companyKey]) ??
      finiteNumber(statsRatings?.[statsKey]);
    if (value !== null) starDistribution[star] = value;
  }

  const score = company ? asObject(company.score) : null;

  const result: ExtractedTrustpilotCompany = {
    domain,
    slug,
    referringDomains,
    name: company ? nonBlankString(company.displayName) : null,
    trustScore: finiteNumber(score?.trustScore),
    reviewsCount,
    starDistribution,
    websiteUrl: company ? nonBlankString(company.websiteUrl) : null,
  };

  const hasSignal =
    result.domain !== null ||
    result.name !== null ||
    result.reviewsCount !== null ||
    result.trustScore !== null;
  return hasSignal ? result : null;
}

/**
 * Wrong-company gate: the expected slug matches when its normalized form
 * equals the company's identifying domain OR appears in its referring list.
 * (Probe finding: identifying name is `www.nike.com`, so both sides are always
 * compared in normalized form.)
 */
export function companyMatchesDomain(
  company: ExtractedTrustpilotCompany,
  expectedDomain: string,
): boolean {
  const expected = normalizeDomain(expectedDomain);
  if (!expected) return false;
  if (company.domain && company.domain === expected) return true;
  return company.referringDomains.includes(expected);
}

/**
 * Groups fallback-search items into unique candidate business units, deduped
 * by NORMALIZED company domain. Candidates carry the EXACT unit slug (`www.`
 * preserved) as their domain/url — the picker's choice becomes the scrape
 * target verbatim. On a normalized-key collision (a dead bare unit and a live
 * `www.` unit for the same brand), the entry with more reviews wins (nulls
 * lose). Items without a company domain are skipped — a candidate the founder
 * can't be shown a page for is noise.
 */
export function groupCandidatesByCompany(
  items: unknown[],
): TrustpilotCandidate[] {
  const byDomain = new Map<string, TrustpilotCandidate>();
  for (const raw of items) {
    const company = extractCompanyFromItem(raw);
    if (!company?.domain) continue;
    const slug = company.slug ?? company.domain;
    const existing = byDomain.get(company.domain);
    if (existing && (existing.reviewsCount ?? -1) >= (company.reviewsCount ?? -1)) {
      continue;
    }
    byDomain.set(company.domain, {
      url: trustpilotUrlFromDomain(slug),
      domain: slug,
      name: company.name,
      trustScore: company.trustScore,
      reviewsCount: company.reviewsCount,
    });
  }
  return [...byDomain.values()];
}

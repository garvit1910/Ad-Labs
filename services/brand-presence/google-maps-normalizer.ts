/**
 * Defensive normalizer for compass/google-maps-reviews-scraper dataset items.
 * Field shapes were verified against a real run (2026-07-07, see the header
 * comment in google-maps-actor-input.ts for the observed item). Unknown
 * shapes are logged and skipped, never thrown — one malformed item must not
 * kill an ingest page.
 *
 * Google-specific quirks handled here:
 * - The review star rating is `stars` (a number); the `rating` key exists on
 *   items but is a different, usually-null field — used only as a fallback.
 * - Star-only reviews with no text are common; they normalize as reviews
 *   with body=null and the processor stores them extraction-skipped (their
 *   stars still count toward aggregates).
 * - With personalData=false the actor nulls reviewerId/name AND reviewUrl,
 *   so `url` falls back to the item's place-level url.
 * - `textTranslated` is preferred for the body when present; the original
 *   text is preserved for verbatim quoting.
 */
import { hashValue } from '@/lib/crypto/oauth-state';
import { containsNameVariant } from './reddit-normalizer';

export interface NormalizedGoogleReview {
  /** The actor's reviewId — the idempotency key. */
  external_id: string;
  /** textTranslated ?? text; null for star-only reviews. */
  body: string | null;
  /** 1.0–5.0 from `stars` (fallback: `rating`). */
  rating: number | null;
  /** ISO timestamp from publishedAtDate; null when unparseable. */
  posted_at: string | null;
  /** reviewUrl, falling back to the item's place url. */
  url: string | null;
  /** sha256 of reviewerId ?? reviewer name — raw identities are never
   * stored; null when personalData=false stripped both. */
  author_ref: string | null;
  likes: number | null;
  owner_response_text: string | null;
  owner_response_at: string | null;
  /** Original text, only when textTranslated was preferred and differs. */
  original_text: string | null;
  review_image_count: number | null;
  place_id: string | null;
}

export type NormalizedGoogleItem =
  | { kind: 'review'; review: NormalizedGoogleReview }
  | { kind: 'skipped'; reason: string };

/** Place metadata repeated on every review item — feeds the resolve probe's
 * confirmation card and the top-up-phase decision. */
export interface ResolvedGooglePlace {
  placeId: string | null;
  title: string | null;
  address: string | null;
  totalScore: number | null;
  reviewsCount: number | null;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Validates a 1..5 star value (0 is not a Google review rating). */
export function parseStars(value: unknown): number | null {
  const num = finiteNumber(value);
  return num !== null && num >= 1 && num <= 5 ? num : null;
}

export function parseReviewTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function normalizeGoogleReviewItem(raw: unknown): NormalizedGoogleItem {
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'skipped', reason: 'non-object item' };
  }
  const item = raw as Record<string, unknown>;

  const reviewId = nonBlankString(item.reviewId)?.trim() ?? null;
  if (!reviewId) {
    return { kind: 'skipped', reason: 'missing reviewId' };
  }

  const text = nonBlankString(item.text);
  const translated = nonBlankString(item.textTranslated);
  const body = translated ?? text;

  const authorSource =
    nonBlankString(item.reviewerId) ?? nonBlankString(item.name);

  return {
    kind: 'review',
    review: {
      external_id: reviewId,
      body,
      rating: parseStars(item.stars) ?? parseStars(item.rating),
      posted_at: parseReviewTimestamp(item.publishedAtDate),
      url: nonBlankString(item.reviewUrl) ?? nonBlankString(item.url),
      author_ref: authorSource ? hashValue(authorSource) : null,
      likes: finiteNumber(item.likesCount),
      owner_response_text: nonBlankString(item.responseFromOwnerText),
      owner_response_at: parseReviewTimestamp(item.responseFromOwnerDate),
      original_text: translated && text && text !== translated ? text : null,
      review_image_count: Array.isArray(item.reviewImageUrls)
        ? item.reviewImageUrls.length
        : null,
      place_id: nonBlankString(item.placeId),
    },
  };
}

/** Address is often null on review items; compose from parts when needed. */
export function extractPlaceMetaFromItem(
  raw: unknown,
): ResolvedGooglePlace | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const composedAddress = [item.street, item.city, item.state]
    .map(nonBlankString)
    .filter((part): part is string => part !== null)
    .join(', ');
  const place: ResolvedGooglePlace = {
    placeId: nonBlankString(item.placeId),
    title: nonBlankString(item.title),
    address: nonBlankString(item.address) ?? (composedAddress || null),
    totalScore: finiteNumber(item.totalScore),
    reviewsCount: finiteNumber(item.reviewsCount),
  };
  const hasSignal =
    place.placeId !== null || place.title !== null || place.reviewsCount !== null;
  return hasSignal ? place : null;
}

/**
 * WRONG-BUSINESS GATE — the Maps twin of the Trustpilot
 * `companyMatchesDomain` check. A Maps URL resolves cleanly to WHATEVER
 * listing it points at, so a clean resolve is NOT evidence the listing is
 * this brand's. Maps reviews carry `relevance='not_required'` (the founder's
 * pasted URL is the whole ownership gate — no relevance LLM), so an
 * unverified listing pipes an entire foreign business's review corpus
 * straight into the VOC corpus. Live incident (2026-07-07 → 07-17): an
 * autologiQ (auto-repair financing) listing confirmed under Magic Spoon put
 * 471 tire/loan-approval reviews into the cereal brand's phrases → themes →
 * facts, where "Customers praise the service as friendly and excellent"
 * outranked every genuine cereal signal at frequency 150.
 *
 * Match is word-boundary containment in EITHER direction: the listing title
 * may carry the brand plus a location or legal suffix ("Magic Spoon Cereal
 * Co. — Brooklyn"), or a variant may be longer than a shortened title.
 * Conservative by construction — a mismatch never blocks the founder, it
 * only withholds AUTO-confirm so a human looks at the card first.
 */
export function placeMatchesBrand(
  placeTitle: string | null | undefined,
  nameVariants: string[],
): boolean {
  const title = placeTitle?.trim();
  if (!title) return false;
  const variants = nameVariants
    .map((variant) => variant.trim())
    .filter((variant) => variant !== '');
  if (variants.length === 0) return false;
  return (
    containsNameVariant(title, variants) ||
    variants.some((variant) => containsNameVariant(variant, [title]))
  );
}

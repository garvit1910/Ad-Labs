import { z } from 'zod';
import { userActivityActorSchema } from '@/lib/user-activity/record';

export const BRAND_PRESENCE_DISCOVER_JOB_TYPE = 'brand_presence_discover';
export const BRAND_PRESENCE_SUBREDDITS_JOB_TYPE =
  'brand_presence_reddit_subreddits';
export const BRAND_PRESENCE_SCRAPE_JOB_TYPE = 'brand_presence_reddit_scrape';
export const BRAND_PRESENCE_RELEVANCE_JOB_TYPE = 'brand_presence_relevance';
export const BRAND_PRESENCE_INSIGHTS_JOB_TYPE = 'brand_presence_insights';
export const BRAND_PRESENCE_AMAZON_PRODUCTS_JOB_TYPE =
  'brand_presence_amazon_products';
export const BRAND_PRESENCE_AMAZON_REVIEWS_JOB_TYPE =
  'brand_presence_amazon_reviews';
export const BRAND_PRESENCE_EXTRACT_JOB_TYPE = 'brand_presence_extract';
export const BRAND_PRESENCE_CLUSTER_JOB_TYPE = 'brand_presence_cluster';
export const BRAND_PRESENCE_GOOGLE_PLACE_JOB_TYPE =
  'brand_presence_google_place';
export const BRAND_PRESENCE_GOOGLE_REVIEWS_JOB_TYPE =
  'brand_presence_google_reviews';
export const BRAND_PRESENCE_X_SCRAPE_JOB_TYPE = 'brand_presence_x_scrape';
export const BRAND_PRESENCE_TRUSTPILOT_RESOLVE_JOB_TYPE =
  'brand_presence_trustpilot_resolve';
export const BRAND_PRESENCE_TRUSTPILOT_REVIEWS_JOB_TYPE =
  'brand_presence_trustpilot_reviews';
export const BRAND_PRESENCE_TIKTOK_PROFILE_JOB_TYPE =
  'brand_presence_tiktok_profile';
export const BRAND_PRESENCE_TIKTOK_COMMENTS_JOB_TYPE =
  'brand_presence_tiktok_comments';
export const BRAND_PRESENCE_INSTAGRAM_PROFILE_JOB_TYPE =
  'brand_presence_instagram_profile';
export const BRAND_PRESENCE_INSTAGRAM_COMMENTS_JOB_TYPE =
  'brand_presence_instagram_comments';

export const BRAND_PRESENCE_JOB_TYPES = [
  BRAND_PRESENCE_DISCOVER_JOB_TYPE,
  BRAND_PRESENCE_SUBREDDITS_JOB_TYPE,
  BRAND_PRESENCE_SCRAPE_JOB_TYPE,
  BRAND_PRESENCE_RELEVANCE_JOB_TYPE,
  // Drain-out alias: in-flight insights jobs from before the extract merge
  // still claim and execute (as extract — identical payload shape). Remove
  // after one release.
  BRAND_PRESENCE_INSIGHTS_JOB_TYPE,
  BRAND_PRESENCE_AMAZON_PRODUCTS_JOB_TYPE,
  BRAND_PRESENCE_AMAZON_REVIEWS_JOB_TYPE,
  BRAND_PRESENCE_GOOGLE_PLACE_JOB_TYPE,
  BRAND_PRESENCE_GOOGLE_REVIEWS_JOB_TYPE,
  BRAND_PRESENCE_X_SCRAPE_JOB_TYPE,
  BRAND_PRESENCE_TRUSTPILOT_RESOLVE_JOB_TYPE,
  BRAND_PRESENCE_TRUSTPILOT_REVIEWS_JOB_TYPE,
  BRAND_PRESENCE_TIKTOK_PROFILE_JOB_TYPE,
  BRAND_PRESENCE_TIKTOK_COMMENTS_JOB_TYPE,
  BRAND_PRESENCE_INSTAGRAM_PROFILE_JOB_TYPE,
  BRAND_PRESENCE_INSTAGRAM_COMMENTS_JOB_TYPE,
  BRAND_PRESENCE_EXTRACT_JOB_TYPE,
  BRAND_PRESENCE_CLUSTER_JOB_TYPE,
] as const;

export const brandPresenceDiscoverPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  websiteUrl: z.string().min(1),
  // Which of the org's two Brand Presence brands to stamp on the created/reused
  // profile. Optional for back-compat with any in-flight legacy job rows.
  presenceRole: z.enum(['self', 'competitor']).optional(),
});
export type BrandPresenceDiscoverPayload = z.infer<
  typeof brandPresenceDiscoverPayloadSchema
>;

export const brandPresenceSubredditsPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
});
export type BrandPresenceSubredditsPayload = z.infer<
  typeof brandPresenceSubredditsPayloadSchema
>;

export const brandPresenceScrapePayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  /** Cursor-based refresh run (sort=new, postDateLimit, smaller cap). */
  refresh: z.boolean().optional().default(false),
});
export type BrandPresenceScrapePayload = z.infer<
  typeof brandPresenceScrapePayloadSchema
>;

export const brandPresenceRelevancePayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  mentionIds: z.array(z.string().uuid()).min(1),
});
export type BrandPresenceRelevancePayload = z.infer<
  typeof brandPresenceRelevancePayloadSchema
>;

export const brandPresenceInsightsPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  mentionIds: z.array(z.string().uuid()).min(1),
});
export type BrandPresenceInsightsPayload = z.infer<
  typeof brandPresenceInsightsPayloadSchema
>;

export const brandPresenceAmazonProductsPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
});
export type BrandPresenceAmazonProductsPayload = z.infer<
  typeof brandPresenceAmazonProductsPayloadSchema
>;

/** Same shape as the old insights payload — the registry alias depends on
 * in-flight insights jobs parsing cleanly as extract jobs. */
export const brandPresenceExtractPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  mentionIds: z.array(z.string().uuid()).min(1),
});
export type BrandPresenceExtractPayload = z.infer<
  typeof brandPresenceExtractPayloadSchema
>;

export const brandPresenceClusterPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
});
export type BrandPresenceClusterPayload = z.infer<
  typeof brandPresenceClusterPayloadSchema
>;

/** Resolve probe: pastes URL -> place metadata for the confirmation card. */
export const brandPresenceGooglePlacePayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  /** Auto-start listening on a clean explicit resolve (the founder's
   * submitted URL/handle IS the consent; ambiguous outcomes stay manual). */
  autoConfirm: z.boolean().optional().default(false),
  /** Who ran the setup: the actor of an auto-confirm's
   * `brand_listening_started` activity event. Absent on older jobs. */
  requestedBy: userActivityActorSchema.optional(),
});
export type BrandPresenceGooglePlacePayload = z.infer<
  typeof brandPresenceGooglePlacePayloadSchema
>;

export const brandPresenceGoogleReviewsPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  /** Cursor refresh: newest-sort + reviewsStartDate floor; the
   * highestRanking top-up phase is skipped. */
  refresh: z.boolean().optional().default(false),
});
export type BrandPresenceGoogleReviewsPayload = z.infer<
  typeof brandPresenceGoogleReviewsPayloadSchema
>;

/** X saved-search scrape: up to two sequential runs (handle query, then the
 * batched name-variant queries) for one x source row. */
export const brandPresenceXScrapePayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  /** Cursor refresh: since: injected into every query, shallow caps. */
  refresh: z.boolean().optional().default(false),
});
export type BrandPresenceXScrapePayload = z.infer<
  typeof brandPresenceXScrapePayloadSchema
>;

/** Resolve probe: derived domain / pasted URL / chosen candidate -> the
 * business-unit metadata for the confirmation card. */
export const brandPresenceTrustpilotResolvePayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  /** false for a founder-pasted URL / chosen candidate (explicit target, no
   * search loop); true only for the auto-derived-domain path. */
  allowSearchFallback: z.boolean().optional().default(true),
  /** Auto-start listening on a clean explicit resolve (the founder's
   * submitted URL/handle IS the consent; ambiguous outcomes stay manual). */
  autoConfirm: z.boolean().optional().default(false),
  /** Who ran the setup: the actor of an auto-confirm's
   * `brand_listening_started` activity event. Absent on older jobs. */
  requestedBy: userActivityActorSchema.optional(),
});
export type BrandPresenceTrustpilotResolvePayload = z.infer<
  typeof brandPresenceTrustpilotResolvePayloadSchema
>;

/** Trustpilot reviews scrape: phased backfill (1–2★ then unfiltered) or a
 * single cursor refresh run for one trustpilot source row. */
export const brandPresenceTrustpilotReviewsPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  /** Cursor refresh: startDate floor from meta.cursor.lastPostedAt, enrichment
   * on, shallow cap; the backfill phases are skipped. */
  refresh: z.boolean().optional().default(false),
});
export type BrandPresenceTrustpilotReviewsPayload = z.infer<
  typeof brandPresenceTrustpilotReviewsPayloadSchema
>;

/** Hop-1 probe: normalized username -> profile card (displayName, followers,
 * videoCount) for the confirmation gate, or the explicit private/not-found
 * terminal state. Nothing scrapes at volume until the founder confirms. */
export const brandPresenceTikTokProfilePayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  /** Auto-start listening on a clean explicit resolve (the founder's
   * submitted URL/handle IS the consent; ambiguous outcomes stay manual). */
  autoConfirm: z.boolean().optional().default(false),
  /** Who ran the setup: the actor of an auto-confirm's
   * `brand_listening_started` activity event. Absent on older jobs. */
  requestedBy: userActivityActorSchema.optional(),
});
export type BrandPresenceTikTokProfilePayload = z.infer<
  typeof brandPresenceTikTokProfilePayloadSchema
>;

/** Two-hop comment harvest: Hop-1 enumeration -> selection policy -> batched
 * Hop-2 runs. refresh = DIFF-driven (re-enumerate, then re-scrape only
 * videos whose commentCount delta crossed the threshold — comments
 * accumulate on OLD videos, so this is NOT a date cursor). */
export const brandPresenceTikTokCommentsPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  refresh: z.boolean().optional().default(false),
});
export type BrandPresenceTikTokCommentsPayload = z.infer<
  typeof brandPresenceTikTokCommentsPayloadSchema
>;

/** Details-mode probe: normalized username -> profile card (fullName,
 * followers, postsCount) for the confirmation gate, or the explicit
 * private/not-found terminal state. Nothing scrapes at volume until the
 * founder confirms. */
export const brandPresenceInstagramProfilePayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  /** Auto-start listening on a clean explicit resolve (the founder's
   * submitted URL/handle IS the consent; ambiguous outcomes stay manual). */
  autoConfirm: z.boolean().optional().default(false),
  /** Who ran the setup: the actor of an auto-confirm's
   * `brand_listening_started` activity event. Absent on older jobs. */
  requestedBy: userActivityActorSchema.optional(),
});
export type BrandPresenceInstagramProfilePayload = z.infer<
  typeof brandPresenceInstagramProfilePayloadSchema
>;

/** Two-hop comment harvest (ONE actor, mode-swapped inputs): posts + reels
 * enumeration -> selection policy -> batched comments-mode runs. refresh =
 * DIFF-driven (recheck the tracked posts' commentsCounts + date-filtered
 * enumeration for new posts, then re-scrape only posts whose delta crossed
 * the threshold — comments accumulate on OLD posts, so this is NOT a date
 * cursor). */
export const brandPresenceInstagramCommentsPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  refresh: z.boolean().optional().default(false),
});
export type BrandPresenceInstagramCommentsPayload = z.infer<
  typeof brandPresenceInstagramCommentsPayloadSchema
>;

export const brandPresenceAmazonReviewsPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  brandProfileId: z.string().uuid(),
  sourceId: z.string().uuid(),
  productId: z.string().uuid(),
  /** Cursor refresh: only reviews newer than product.review_cursor are kept;
   * the critical-star pass is skipped. */
  refresh: z.boolean().optional().default(false),
});
export type BrandPresenceAmazonReviewsPayload = z.infer<
  typeof brandPresenceAmazonReviewsPayloadSchema
>;

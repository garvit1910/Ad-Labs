import type { ErrorCodeKeys } from '../localize-error';

/**
 * Ads Manager automated rules (`hooks/use-automated-rules`, `/api/meta/rules`):
 * the hook's synthetic "no organization / ad account" code.
 */
export const AUTOMATED_RULES_ERROR_KEYS = {
  MISSING_RULES_SCOPE: 'AdsManager.rules.toasts.missingScope',
} as const satisfies ErrorCodeKeys;

/**
 * Ads Manager row mutations — status toggle, budget edit, delete, duplicate
 * (`POST /api/ads-manager/status`, `/budget`, `/api/meta/*` DELETE and
 * duplicate, `/api/tiktok/delete`, `/api/tiktok/duplicate`): codes whose
 * generic copy beats "the change wasn't applied". Everything unmapped renders
 * `AdsManager.common.platformConnection.notApplied`, never the provider text
 * (`components/ads-manager/i18n/use-mutation-error-text.ts`).
 */
export const ADS_MANAGER_MUTATION_ERROR_KEYS = {
  SPEND_PERMISSION_DENIED: 'Common.errors.permissionDenied',
  ENTITY_NOT_FOUND: 'Common.errors.notFound',
  TIKTOK_RATE_LIMITED: 'Common.errors.rateLimited',
} as const satisfies ErrorCodeKeys;

/**
 * Ads Manager inline budget edit (`BudgetCell`, `POST /api/ads-manager/budget`,
 * incl. its X "Remove total budget" form): the spend-approval queue could not
 * be reached (503); a member's over-limit X change could not be checked
 * because X's current budget could not be read (503, retryable).
 */
export const BUDGET_ERROR_KEYS = {
  SPEND_APPROVAL_UNAVAILABLE: 'AdsManager.budget.toasts.approvalUnavailable',
  PREVIOUS_BUDGET_UNAVAILABLE: 'AdsManager.budget.toasts.previousBudgetUnavailable',
} as const satisfies ErrorCodeKeys;

/**
 * Meta create modal ad publisher (`create-campaign-modal/components/ad-publisher`):
 * local publish-guard / publish-stage failures thrown as `CodedError`s by
 * `metaPublishError()` (`publish-errors.ts`) and `toMetaPublishFailure()`.
 * No HTTP status — Meta's own free-text refusals stay unmapped and render as
 * a secondary `lang="en"` line (`useMetaErrorText`).
 */
export const META_PUBLISH_ERROR_KEYS = {
  META_PUBLISH_EXISTING_POST_REQUIRED: 'AdsManager.meta.publishErrors.existingPostRequired',
  META_PUBLISH_MULTI_ADVERTISER_UNSUPPORTED: 'AdsManager.meta.publishErrors.multiAdvertiserUnsupported',
  META_PUBLISH_PARTNERSHIP_UNSUPPORTED: 'AdsManager.meta.publishErrors.partnershipUnsupported',
  META_PUBLISH_COLLECTION_UNSUPPORTED: 'AdsManager.meta.publishErrors.collectionUnsupported',
  META_PUBLISH_CAROUSEL_CALLS_UNSUPPORTED: 'AdsManager.meta.publishErrors.carouselCallsUnsupported',
  META_PUBLISH_CAROUSEL_MIN_CARDS: 'AdsManager.meta.publishErrors.carouselMinCards',
  META_PUBLISH_CAROUSEL_VIDEO_SOURCE: 'AdsManager.meta.publishErrors.carouselVideoSource',
  META_PUBLISH_CAROUSEL_VIDEO_THUMBNAIL: 'AdsManager.meta.publishErrors.carouselVideoThumbnail',
  META_PUBLISH_CAROUSEL_INVALID_LINK: 'AdsManager.meta.publishErrors.carouselInvalidLink',
  META_PUBLISH_CAROUSEL_LINK_REQUIRED: 'AdsManager.meta.publishErrors.carouselLinkRequired',
  META_PUBLISH_TRAFFIC_CALL_DESTINATION: 'AdsManager.meta.publishErrors.trafficCallDestination',
  META_PUBLISH_DESTINATION_UNSUPPORTED: 'AdsManager.meta.publishErrors.destinationUnsupported',
  META_PUBLISH_PHONE_REQUIRED: 'AdsManager.meta.publishErrors.phoneRequired',
  META_PUBLISH_CTA_UNAVAILABLE: 'AdsManager.meta.publishErrors.ctaUnavailable',
  META_PUBLISH_PAGE_REQUIRED: 'AdsManager.meta.publishErrors.pageRequired',
  META_PUBLISH_WEBSITE_URL_REQUIRED: 'AdsManager.meta.publishErrors.websiteUrlRequired',
  META_PUBLISH_DISPLAY_LINK_UNSUPPORTED: 'AdsManager.meta.publishErrors.displayLinkUnsupported',
  META_PUBLISH_BROWSER_ADDON_UNSUPPORTED: 'AdsManager.meta.publishErrors.browserAddOnUnsupported',
  META_PUBLISH_TRACKING_UNSUPPORTED: 'AdsManager.meta.publishErrors.trackingUnsupported',
  META_PUBLISH_MEDIA_REQUIRED: 'AdsManager.meta.publishErrors.mediaRequired',
  META_PUBLISH_VIDEO_PREPARE_FAILED: 'AdsManager.meta.publishErrors.videoPrepareFailed',
  META_PUBLISH_VIDEO_THUMBNAIL_REQUIRED: 'AdsManager.meta.publishErrors.videoThumbnailRequired',
  META_PUBLISH_LOCAL_SAVE_FAILED: 'AdsManager.meta.publishErrors.localSaveFailed',
  META_PUBLISH_LOCAL_SYNC_FAILED: 'AdsManager.meta.publishErrors.localSyncFailed',
  META_PUBLISH_AD_NAME_REQUIRED: 'AdsManager.meta.publishErrors.adNameRequired',
  META_PUBLISH_CAMPAIGN_NAME_REQUIRED: 'AdsManager.meta.publishErrors.campaignNameRequired',
  META_PUBLISH_NAME_TOO_LONG: 'AdsManager.meta.publishErrors.nameTooLong',
  META_PUBLISH_API_CONFIG_MISSING: 'AdsManager.meta.publishErrors.apiConfigMissing',
  META_PUBLISH_CAMPAIGN_AND_AD_SET_REQUIRED: 'AdsManager.meta.publishErrors.campaignAndAdSetRequired',
  META_UPDATE_AD_NOT_LOADED: 'AdsManager.meta.publishErrors.adNotLoaded',
  META_UPDATE_CREATIVE_UNSUPPORTED: 'AdsManager.meta.publishErrors.creativeEditUnsupported',
} as const satisfies ErrorCodeKeys;

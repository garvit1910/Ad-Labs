import type { ErrorCodeKeys } from '../localize-error';

/**
 * `GET /api/google-ads/conversion-actions?adAccountId=`,
 * `PUT /api/google-ads/conversion-action`, `POST .../conversion-action/create`
 * and `POST .../conversion-action/test-upload` (Settings "Send conversions to
 * Google", `GoogleConversionActionSection`). Every code these routes return is
 * mapped, and the section renders the catalog copy in EVERY locale, English
 * included (`catalogKeyForCode`): the server reasons carry raw account/action ids.
 */
export const GOOGLE_CONVERSION_ACTION_ERROR_KEYS = {
  GOOGLE_CONVERSION_ACTION_NOT_FOUND: 'Settings.organizationDashboard.googleConversions.errors.actionNotFound',
  GOOGLE_CONVERSION_ACTION_NOT_UPLOAD: 'Settings.organizationDashboard.googleConversions.errors.notUpload',
  GOOGLE_CONVERSION_ACTION_NOT_ENABLED: 'Settings.organizationDashboard.googleConversions.errors.notEnabled',
  GOOGLE_ACCOUNT_NOT_FOUND: 'Settings.organizationDashboard.googleConversions.errors.accountNotFound',
  GOOGLE_CONVERSION_ACTION_NAME_TAKEN: 'Settings.organizationDashboard.googleConversions.errors.nameTaken',
  GOOGLE_PRIMARY_PURCHASE_ACTION_EXISTS: 'Settings.organizationDashboard.googleConversions.errors.primaryExists',
  GOOGLE_ADS_PERMISSION_DENIED: 'Settings.organizationDashboard.googleConversions.errors.googlePermission',
  GOOGLE_CONVERSION_ACTION_CREATE_REFUSED: 'Settings.organizationDashboard.googleConversions.errors.createRefused',
  GOOGLE_ACCOUNT_CURRENCY_UNKNOWN: 'Settings.organizationDashboard.googleConversions.errors.currencyUnknown',
  GOOGLE_CONVERSION_DESTINATION_NOT_CONFIGURED: 'Settings.organizationDashboard.googleConversions.errors.destinationNotConfigured',
  GOOGLE_ADS_TIMEOUT: 'Settings.organizationDashboard.googleConversions.errors.googleTimeout',
  GOOGLE_ADS_UPSTREAM_ERROR: 'Settings.organizationDashboard.googleConversions.errors.googleError',
  GOOGLE_NOT_CONNECTED: 'Common.errors.platformConnectionExpired',
  GOOGLE_AUTH_EXPIRED: 'Common.errors.platformConnectionExpired',
  SPEND_PERMISSION_DENIED: 'Common.errors.permissionDenied',
  INSUFFICIENT_SCOPE: 'Common.errors.permissionDenied',
  KEY_CREATOR_NOT_AUTHORIZED: 'Common.errors.permissionDenied',
  PERMISSION_DENIED: 'Common.errors.permissionDenied',
  CROSS_ORG_ACCESS_DENIED: 'Common.errors.permissionDenied',
} as const satisfies ErrorCodeKeys;

/** Google Ads / TikTok / LinkedIn / X `select-account` POST routes. */
export const ACCOUNT_SELECTION_ERROR_KEYS = {
  NOT_FOUND: 'Settings.organizations.accountSelection.errors.setupExpired',
  INTEGRATION_NOT_FOUND: 'Settings.organizations.accountSelection.errors.setupExpired',
  TWITTER_NOT_CONNECTED: 'Settings.organizations.accountSelection.errors.setupExpired',
  ACCOUNT_NOT_IN_INTEGRATION: 'Settings.organizations.accountSelection.errors.accountNotAvailable',
  TWITTER_ACCOUNT_NOT_DISCOVERED:
    'Settings.organizations.accountSelection.errors.accountNotAvailable',
} as const satisfies ErrorCodeKeys;

/**
 * `POST /api/accounts/save` refusals for a Facebook Page / Instagram row whose
 * token the server resolves itself (`app/api/accounts/save/route.ts`). Each
 * copy carries the remediation, so the Settings Meta selector and the connect
 * modal render it in EVERY locale, English included (`catalogKeyForCode`):
 * the server `reason` alone does not tell the user what to do.
 */
export const META_PAGE_CREDENTIAL_ERROR_KEYS = {
  META_PAGE_TOKEN_UNAVAILABLE: 'Settings.connectAccountModal.save.credentialPageTokenUnavailable',
  META_CONNECTION_REQUIRED: 'Settings.connectAccountModal.save.credentialConnectionRequired',
  META_RAW_TOKEN_REJECTED: 'Settings.connectAccountModal.save.credentialRawTokenRejected',
  META_CREDENTIAL_ADMIN_REQUIRED: 'Settings.connectAccountModal.save.credentialAdminRequired',
  TOKEN_SOURCE_NOT_FOUND: 'Settings.connectAccountModal.save.credentialInstagramPageMissing',
} as const satisfies ErrorCodeKeys;

/** `POST /api/accounts/save` (Meta connect modal). */
export const META_ACCOUNT_SAVE_ERROR_KEYS = {
  RECONNECT_ACCOUNT_MISMATCH: 'Settings.connectAccountModal.save.notReconnectingAccount',
  ...META_PAGE_CREDENTIAL_ERROR_KEYS,
} as const satisfies ErrorCodeKeys;

/**
 * Meta connect modal (`hooks/use-facebook-auth/**` → `ConnectAccountModal`):
 * `/api/auth/facebook/oauth-data` and `/api/meta/pages` warning codes plus the
 * hooks' own synthetic `FACEBOOK_*` codes.
 */
export const FACEBOOK_AUTH_ERROR_KEYS = {
  OAUTH_DATA_EXPIRED: 'Settings.connectAccount.facebookAuth.errors.sessionExpired',
  META_OAUTH_MISCONFIGURED: 'Settings.connectAccount.facebookAuth.errors.misconfigured',
  // oauth-data's 404 (no OAuth cookie) and 400 (unreadable cookie) both mean
  // the OAuth handoff did not complete — not "item not found"/"invalid input".
  NOT_FOUND: 'Settings.connectAccount.facebookAuth.errors.connectionIncomplete',
  VALIDATION_ERROR: 'Settings.connectAccount.facebookAuth.errors.connectionIncomplete',
  FACEBOOK_CONNECTION_INCOMPLETE: 'Settings.connectAccount.facebookAuth.errors.connectionIncomplete',
  FACEBOOK_LOGIN_REQUIRED: 'Settings.connectAccount.facebookAuth.errors.loginRequired',
  FACEBOOK_AUTH_EXPIRED: 'Settings.connectAccount.facebookAuth.errors.sessionExpired',
  FACEBOOK_PAGES_FETCH_FAILED: 'Settings.connectAccount.facebookAuth.errors.pagesFetchFailed',
  FACEBOOK_LOGIN_START_FAILED: 'Settings.connectAccount.facebookAuth.errors.loginFailed',
  FACEBOOK_LOGIN_NO_AUTH_URL: 'Settings.connectAccount.facebookAuth.errors.loginFailed',
  PAGE_LIST_INCOMPLETE: 'Settings.connectAccount.facebookAuth.errors.pageListIncomplete',
} as const satisfies ErrorCodeKeys;

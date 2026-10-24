import type { ErrorCodeKeys } from '../localize-error';

/**
 * `POST /api/integrations/shopify/repair-webhooks` (the Shopify card's Repair
 * webhooks action): the route's own `PERMISSION_DENIED` (admin/owner only) and
 * `SHOPIFY_WEBHOOK_REPAIR_FAILED`, plus every `ShopifyWebhookRepairError` code
 * from `lib/shopify/webhook-repair.ts`. The card never queues order recovery,
 * so the recovery-window codes only fall back to the generic failure.
 */
export const SHOPIFY_WEBHOOK_REPAIR_ERROR_KEYS = {
  PERMISSION_DENIED: 'Integrations.platforms.shopify.card.repair.errors.permissionDenied',
  INTEGRATION_NOT_FOUND: 'Common.errors.notFound',
  INTEGRATION_INACTIVE: 'Integrations.platforms.shopify.card.repair.errors.inactive',
  SHOPIFY_CREDENTIALS_UNAVAILABLE:
    'Integrations.platforms.shopify.card.repair.errors.credentialsUnavailable',
  SELECTION_HASH_MISMATCH: 'Integrations.platforms.shopify.card.repair.errors.selectionChanged',
  INTEGRATION_LOOKUP_FAILED: 'Integrations.platforms.shopify.card.repair.errors.failed',
  WEBHOOK_REPAIR_SAVE_FAILED: 'Integrations.platforms.shopify.card.repair.errors.failed',
  RECOVERY_START_DATE_REQUIRED: 'Integrations.platforms.shopify.card.repair.errors.failed',
  INVALID_RECOVERY_WINDOW: 'Integrations.platforms.shopify.card.repair.errors.failed',
  SHOPIFY_WEBHOOK_REPAIR_FAILED: 'Integrations.platforms.shopify.card.repair.errors.failed',
} as const satisfies ErrorCodeKeys;

/**
 * `?error_code=` set beside the English `?error=` text by every OAuth callback
 * that lands on `/settings` (rendered by `app/settings/SettingsPageClient.tsx`):
 * `api/auth/facebook/callback`, `api/auth/tiktok/callback`,
 * `api/integrations/{tiktok,google-ads,linkedin,twitter,pinterest-ads}/…`.
 * Codes are `<PROVIDER>_<CODE>`; Google Ads discovery failures reuse
 * `describeGoogleAdsDiscoveryError().auditCode`.
 */
export const SETTINGS_OAUTH_ERROR_KEYS = {
  // Meta (`/api/auth/facebook/callback`)
  META_OAUTH_STATE_INVALID: 'Settings.page.oauth.errors.stateInvalid',
  META_OAUTH_DENIED: 'Settings.page.oauth.errors.denied',
  META_OAUTH_PROVIDER_ERROR: 'Settings.page.oauth.errors.connectionFailed',
  META_OAUTH_NO_CODE: 'Settings.page.oauth.errors.missingCode',
  META_OAUTH_MISCONFIGURED: 'Settings.page.oauth.errors.configuration',
  META_OAUTH_TOKEN_EXCHANGE_FAILED: 'Settings.page.oauth.errors.tokenExchangeFailed',
  META_OAUTH_NO_DURABLE_TOKEN: 'Settings.page.oauth.errors.noDurableToken',
  META_OAUTH_CALLBACK_FAILED: 'Settings.page.oauth.errors.connectionFailed',
  // TikTok (`/api/auth/tiktok/callback`, `/api/integrations/tiktok/{auth,callback}`)
  TIKTOK_OAUTH_MISCONFIGURED: 'Settings.page.oauth.errors.configuration',
  TIKTOK_OAUTH_STATE_INVALID: 'Settings.page.oauth.errors.stateInvalid',
  TIKTOK_OAUTH_DENIED: 'Settings.page.oauth.errors.denied',
  TIKTOK_OAUTH_NO_CODE: 'Settings.page.oauth.errors.missingCode',
  TIKTOK_OAUTH_TOKEN_EXCHANGE_FAILED: 'Settings.page.oauth.errors.tokenExchangeFailed',
  TIKTOK_ALREADY_CONNECTED: 'Settings.page.oauth.errors.tiktokAlreadyConnected',
  TIKTOK_NO_AD_ACCOUNTS: 'Settings.page.oauth.errors.noAdAccounts',
  TIKTOK_SETUP_FAILED: 'Settings.page.oauth.errors.setupFailed',
  TIKTOK_CALLBACK_FAILED: 'Settings.page.oauth.errors.connectionFailed',
  // Google Ads (`/api/integrations/google-ads/callback`)
  GOOGLE_ADS_OAUTH_DENIED: 'Settings.page.oauth.errors.denied',
  GOOGLE_ADS_OAUTH_NO_CODE: 'Settings.page.oauth.errors.missingCode',
  GOOGLE_ADS_OAUTH_STATE_INVALID: 'Settings.page.oauth.errors.stateInvalid',
  GOOGLE_ADS_NO_AD_ACCOUNTS: 'Settings.page.oauth.errors.noAdAccounts',
  GOOGLE_ADS_SETUP_FAILED: 'Settings.page.oauth.errors.setupFailed',
  GOOGLE_ADS_CALLBACK_FAILED: 'Settings.page.oauth.errors.connectionFailed',
  GOOGLE_ADS_NOT_ADS_USER: 'Settings.page.oauth.errors.googleNotAdsUser',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'Settings.page.oauth.errors.configuration',
  GOOGLE_ADS_AUTHENTICATION_FAILED: 'Settings.page.oauth.errors.googleAuthFailed',
  GOOGLE_ADS_PERMISSION_DENIED: 'Settings.page.oauth.errors.googlePermissionDenied',
  GOOGLE_ADS_CUSTOMER_NOT_ENABLED: 'Settings.page.oauth.errors.googleCustomerNotEnabled',
  GOOGLE_ADS_RATE_LIMITED: 'Common.errors.rateLimited',
  GOOGLE_ADS_API_ERROR: 'Settings.page.oauth.errors.googleApiError',
  // LinkedIn (`/api/integrations/linkedin/callback`)
  LINKEDIN_OAUTH_STATE_INVALID: 'Settings.page.oauth.errors.stateInvalid',
  LINKEDIN_OAUTH_DENIED: 'Settings.page.oauth.errors.denied',
  LINKEDIN_NO_AD_ACCOUNTS: 'Settings.page.oauth.errors.noAdAccounts',
  LINKEDIN_SETUP_FAILED: 'Settings.page.oauth.errors.setupFailed',
  LINKEDIN_CALLBACK_FAILED: 'Settings.page.oauth.errors.connectionFailed',
  // X (`/api/integrations/twitter/callback`)
  TWITTER_OAUTH_STATE_INVALID: 'Settings.page.oauth.errors.stateInvalid',
  TWITTER_OAUTH_DENIED: 'Settings.page.oauth.errors.denied',
  TWITTER_NO_AD_ACCOUNTS: 'Settings.page.oauth.errors.noAdAccounts',
  TWITTER_CALLBACK_FAILED: 'Settings.page.oauth.errors.connectionFailed',
  // Pinterest (`/api/integrations/pinterest-ads/callback`, `oauth-return.ts`)
  PINTEREST_OAUTH_DENIED: 'Settings.page.oauth.errors.denied',
  PINTEREST_OAUTH_NO_CODE: 'Settings.page.oauth.errors.missingCode',
  PINTEREST_OAUTH_STATE_INVALID: 'Settings.page.oauth.errors.stateInvalid',
  PINTEREST_NO_AD_ACCOUNTS: 'Settings.page.oauth.errors.noAdAccounts',
  PINTEREST_AD_ACCOUNTS_UNREADABLE: 'Settings.page.oauth.errors.adAccountsUnreadable',
  PINTEREST_ACCOUNT_PERSIST_FAILED: 'Settings.page.oauth.errors.accountPersistFailed',
  PINTEREST_CALLBACK_FAILED: 'Settings.page.oauth.errors.connectionFailed',
  // Ad-account connect role gate (`lib/auth/account-connect-access.ts`): a
  // viewer's OAuth callback (TikTok login, X, Pinterest) redirects with this
  // (Pinterest's Attribution return inherits it via `ATTRIBUTION_OAUTH_ERROR_KEYS`).
  INSUFFICIENT_ROLE: 'Common.errors.accountConnectRoleDenied',
} as const satisfies ErrorCodeKeys;

/**
 * `?success_code=` beside the `?success=` text on the same callbacks. Unlike
 * error codes, a KNOWN success code renders its catalog copy in every locale,
 * English included — the `success` text is not always a sentence (X sends
 * `success=twitter`). An unknown/missing code keeps the `success` text in
 * English and `Settings.page.oauth.success.connected` elsewhere.
 */
export const SETTINGS_OAUTH_SUCCESS_KEYS = {
  TWITTER_CONNECTED: 'Settings.page.oauth.success.twitterConnected',
  PINTEREST_CONNECTED: 'Settings.page.oauth.success.pinterestConnected',
} as const satisfies ErrorCodeKeys;

/**
 * Settings / Attribution → Integrations connect, sync and disconnect routes
 * (`app/api/integrations/**`, `app/api/commerce/sync`). Provider-specific
 * codes from `lib/recharge/types.ts` (`RechargeConnectErrorCode`) and the
 * Shopify connect preflight; `*_NOT_CONFIGURED` is our server setup, not the
 * merchant's.
 */
export const INTEGRATION_ERROR_KEYS = {
  CONNECT_FAILED: 'Integrations.errors.connectFailed',
  OAUTH_START_FAILED: 'Integrations.errors.oauthStartFailed',
  OAUTH_DENIED: 'Settings.page.oauth.errors.denied',
  CONFIGURATION_ERROR: 'Settings.page.oauth.errors.configuration',
  SERVER_CONFIGURATION_ERROR: 'Settings.page.oauth.errors.configuration',
  STRIPE_NOT_CONFIGURED: 'Settings.page.oauth.errors.configuration',
  RECHARGE_OAUTH_NOT_CONFIGURED: 'Settings.page.oauth.errors.configuration',
  INVALID_API_KEY: 'Integrations.errors.codes.invalidApiKey',
  INVALID_CREDENTIALS: 'Integrations.errors.codes.invalidCredentials',
  INTEGRATION_NOT_FOUND: 'Common.errors.notFound',
  FORBIDDEN_ORGANIZATION: 'Common.errors.permissionDenied',
  ORGANIZATION_SCOPE_MISMATCH: 'Common.errors.permissionDenied',
  RECHARGE_TOKEN_INVALID: 'Integrations.errors.codes.rechargeTokenInvalid',
  RECHARGE_SCOPE_MISSING: 'Integrations.errors.codes.rechargeScopeMissing',
  RECHARGE_CLIENT_SECRET_MISSING: 'Integrations.errors.codes.rechargeClientSecretMissing',
  RECHARGE_STORE_ALREADY_CONNECTED: 'Integrations.errors.codes.rechargeStoreAlreadyConnected',
  RECHARGE_RATE_LIMITED: 'Common.errors.rateLimited',
  RECHARGE_UNAVAILABLE: 'Integrations.errors.codes.providerUnavailable',
  SEGMENT_UNAVAILABLE: 'Integrations.errors.codes.providerUnavailable',
  SHOPIFY_SCOPES_MISSING: 'Integrations.errors.codes.shopifyScopesMissing',
  SHOPIFY_PREFLIGHT_FAILED: 'Integrations.errors.codes.shopifyPreflightFailed',
  // Token exchange says the custom app is not installed on the store
  // (`lib/shopify/credential-exchange-error.ts`, connect + preflight routes).
  SHOPIFY_APP_NOT_INSTALLED: 'Integrations.errors.codes.shopifyAppNotInstalled',
  // One external store/site/account per active organization (409):
  // `lib/shopify/connected-elsewhere.ts`, `lib/integrations/connected-elsewhere.ts`.
  SHOPIFY_STORE_CONNECTED_ELSEWHERE: 'Integrations.errors.codes.shopifyStoreConnectedElsewhere',
  WOOCOMMERCE_STORE_CONNECTED_ELSEWHERE: 'Integrations.errors.codes.woocommerceStoreConnectedElsewhere',
  // WooCommerce store URL / REST API reachability (`lib/woocommerce/client.ts`, connect + wc-auth start).
  WOOCOMMERCE_STORE_NOT_FOUND: 'Integrations.errors.codes.woocommerceStoreNotFound',
  WOOCOMMERCE_API_NOT_FOUND: 'Integrations.errors.codes.woocommerceApiNotFound',
  WOOCOMMERCE_CONNECTION_FAILED: 'Integrations.errors.codes.woocommerceConnectionFailed',
  // Private / local / non-HTTPS store URL (`lib/woocommerce/store-url-guard.ts`).
  WOOCOMMERCE_STORE_URL_NOT_ALLOWED: 'Integrations.errors.codes.woocommerceStoreUrlNotAllowed',
  WOOCOMMERCE_API_ERROR: 'Integrations.errors.codes.woocommerceApiError',
  WEBFLOW_SITE_CONNECTED_ELSEWHERE: 'Integrations.errors.codes.webflowSiteConnectedElsewhere',
  HUBSPOT_PORTAL_CONNECTED_ELSEWHERE: 'Integrations.errors.codes.hubspotPortalConnectedElsewhere',
  GOHIGHLEVEL_LOCATION_CONNECTED_ELSEWHERE: 'Integrations.errors.codes.gohighlevelLocationConnectedElsewhere',
  GUMROAD_ACCOUNT_CONNECTED_ELSEWHERE: 'Integrations.errors.codes.gumroadAccountConnectedElsewhere',
  // Browser-extension link (`autoLinkExtension` client codes + `POST /api/extension/link`).
  EXTENSION_UNREACHABLE: 'Integrations.extension.errors.unreachable',
  EXTENSION_STORE_FAILED: 'Integrations.extension.errors.storeFailed',
  FORBIDDEN_ORIGIN: 'Integrations.extension.errors.forbiddenOrigin',
  INSTALL_ID_OWNED_BY_OTHER_USER: 'Integrations.extension.errors.installIdOwned',
} as const satisfies ErrorCodeKeys;

/**
 * `?error_code=` set beside the English `?error=` text by every OAuth callback
 * that lands on `/attribution` (read by `localizedOAuthCallbackError()` in
 * `hooks/integrations/oauth-callback-messages.ts`). `Integrations.oauthCallback.errors.*`
 * copy takes a `{platform}` brand name, which the reader derives from the
 * code's `<PROVIDER>_` prefix (or the `platform` param) — so only
 * provider-prefixed codes may point at those keys; shared codes (`OAUTH_STATE_*`)
 * use platform-less copy. The TikTok / Google Ads / Pinterest attribution
 * intents send the same codes as their Settings path (`SETTINGS_OAUTH_ERROR_KEYS`),
 * and connect-service codes (Recharge, connected-elsewhere, Shopify scopes) come
 * from `INTEGRATION_ERROR_KEYS`. An unmapped code renders "Couldn't connect
 * {platform}" in non-English locales, never the English server text.
 */
export const ATTRIBUTION_OAUTH_ERROR_KEYS = {
  ...SETTINGS_OAUTH_ERROR_KEYS,
  ...INTEGRATION_ERROR_KEYS,
  // Shared OAuth-state rows (`consume*OAuthState`, platform from `?platform=`)
  OAUTH_STATE_INVALID: 'Settings.page.oauth.errors.stateInvalid',
  OAUTH_STATE_EXPIRED: 'Settings.page.oauth.errors.stateInvalid',
  OAUTH_STATE_REPLAYED: 'Settings.page.oauth.errors.stateInvalid',
  // Shopify (`/api/integrations/shopify/callback`)
  SHOPIFY_OAUTH_NOT_ENABLED: 'Integrations.oauthCallback.errors.configuration',
  SHOPIFY_OAUTH_MISCONFIGURED: 'Integrations.oauthCallback.errors.configuration',
  SHOPIFY_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  SHOPIFY_OAUTH_MISSING_PARAMS: 'Integrations.oauthCallback.errors.missingParams',
  SHOPIFY_OAUTH_HMAC_INVALID: 'Integrations.oauthCallback.errors.shopifyHmacInvalid',
  SHOPIFY_OAUTH_STATE_INVALID: 'Integrations.oauthCallback.errors.sessionExpired',
  SHOPIFY_OAUTH_SHOP_MISMATCH: 'Integrations.oauthCallback.errors.shopifyShopMismatch',
  SHOPIFY_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  // Microsoft Advertising (`/api/integrations/bing-ads/callback`)
  BING_ADS_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  BING_ADS_OAUTH_NO_CODE: 'Integrations.oauthCallback.errors.missingParams',
  BING_ADS_OAUTH_STATE_INVALID: 'Integrations.oauthCallback.errors.sessionExpired',
  BING_ADS_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  // Reddit Ads (`/api/integrations/reddit-ads/callback`)
  REDDIT_ADS_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  REDDIT_ADS_OAUTH_NO_CODE: 'Integrations.oauthCallback.errors.missingParams',
  REDDIT_ADS_OAUTH_STATE_INVALID: 'Integrations.oauthCallback.errors.sessionExpired',
  REDDIT_ADS_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  // Snapchat Ads (`/api/integrations/snapchat-ads/callback`)
  SNAPCHAT_ADS_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  SNAPCHAT_ADS_OAUTH_NO_CODE: 'Integrations.oauthCallback.errors.missingParams',
  SNAPCHAT_ADS_OAUTH_STATE_INVALID: 'Integrations.oauthCallback.errors.sessionExpired',
  SNAPCHAT_ADS_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  // Google Analytics (`/api/integrations/google-analytics/callback`); thrown
  // `GoogleAnalyticsApiError` codes (`GA4_*`) fall back to "Couldn't connect".
  GA4_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  GA4_OAUTH_NO_CODE: 'Integrations.oauthCallback.errors.missingParams',
  GA4_OAUTH_STATE_INVALID: 'Integrations.oauthCallback.errors.sessionExpired',
  GA4_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  // Mailchimp (`/api/integrations/mailchimp/callback`, `MAILCHIMP_<api code>`)
  MAILCHIMP_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  MAILCHIMP_OAUTH_NO_CODE: 'Integrations.oauthCallback.errors.missingParams',
  MAILCHIMP_OAUTH_MISCONFIGURED: 'Integrations.oauthCallback.errors.configuration',
  MAILCHIMP_OAUTH_STATE_EXPIRED: 'Integrations.oauthCallback.errors.sessionExpired',
  MAILCHIMP_OAUTH_STATE_INVALID: 'Integrations.oauthCallback.errors.sessionExpired',
  MAILCHIMP_TOKEN_EXCHANGE_FAILED: 'Integrations.oauthCallback.errors.tokenExchangeFailed',
  MAILCHIMP_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  // Stripe / Recharge / Gumroad / Webflow / HubSpot / GoHighLevel / WooCommerce
  // (`normalizeCallbackError` in each `/api/integrations/<p>/callback`)
  STRIPE_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  STRIPE_CALLBACK_MISSING_PARAMS: 'Integrations.oauthCallback.errors.missingParams',
  STRIPE_TOKEN_EXCHANGE_FAILED: 'Integrations.oauthCallback.errors.tokenExchangeFailed',
  STRIPE_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  RECHARGE_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  RECHARGE_CALLBACK_MISSING_PARAMS: 'Integrations.oauthCallback.errors.missingParams',
  RECHARGE_TOKEN_EXCHANGE_FAILED: 'Integrations.oauthCallback.errors.tokenExchangeFailed',
  RECHARGE_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  GUMROAD_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  GUMROAD_CALLBACK_MISSING_PARAMS: 'Integrations.oauthCallback.errors.missingParams',
  GUMROAD_TOKEN_EXCHANGE_FAILED: 'Integrations.oauthCallback.errors.tokenExchangeFailed',
  GUMROAD_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  // OAuth connects refused because the account is active in another org land
  // here as `?error_code=`; without these they rendered the generic copy.
  GUMROAD_ACCOUNT_CONNECTED_ELSEWHERE: 'Integrations.errors.codes.gumroadAccountConnectedElsewhere',
  HUBSPOT_PORTAL_CONNECTED_ELSEWHERE: 'Integrations.errors.codes.hubspotPortalConnectedElsewhere',
  GOHIGHLEVEL_LOCATION_CONNECTED_ELSEWHERE: 'Integrations.errors.codes.gohighlevelLocationConnectedElsewhere',
  WEBFLOW_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  WEBFLOW_CALLBACK_MISSING_PARAMS: 'Integrations.oauthCallback.errors.missingParams',
  WEBFLOW_TOKEN_EXCHANGE_FAILED: 'Integrations.oauthCallback.errors.tokenExchangeFailed',
  WEBFLOW_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  HUBSPOT_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  HUBSPOT_CALLBACK_MISSING_PARAMS: 'Integrations.oauthCallback.errors.missingParams',
  HUBSPOT_TOKEN_EXCHANGE_FAILED: 'Integrations.oauthCallback.errors.tokenExchangeFailed',
  HUBSPOT_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  GOHIGHLEVEL_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  GOHIGHLEVEL_CALLBACK_MISSING_PARAMS: 'Integrations.oauthCallback.errors.missingParams',
  GOHIGHLEVEL_TOKEN_EXCHANGE_FAILED: 'Integrations.oauthCallback.errors.tokenExchangeFailed',
  GOHIGHLEVEL_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
  WOOCOMMERCE_OAUTH_DENIED: 'Integrations.oauthCallback.errors.denied',
  WOOCOMMERCE_CALLBACK_MISSING_STATE: 'Integrations.oauthCallback.errors.sessionExpired',
  WOOCOMMERCE_CALLBACK_FAILED: 'Integrations.oauthCallback.errors.connectFailed',
} as const satisfies ErrorCodeKeys;

/**
 * `?warning_code=` on a SUCCESSFUL `/attribution` callback redirect (the
 * connection was saved, but setup is incomplete). A known code renders its
 * catalog copy in every locale, English included, as a warning — never as an
 * error. `TIKTOK_PIXEL_MISSING`: `/api/integrations/tiktok/callback`
 * attribution intent, advertiser has no pixel.
 */
export const ATTRIBUTION_OAUTH_WARNING_KEYS = {
  TIKTOK_PIXEL_MISSING: 'Integrations.oauthCallback.warnings.tiktokPixelMissing',
} as const satisfies ErrorCodeKeys;

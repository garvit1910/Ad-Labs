/**
 * Per-surface server error code → catalog key maps for `localizeError()`
 * (`lib/i18n/localize-error.ts`). Each map is merged over
 * `DEFAULT_ERROR_CODE_KEYS`, so list only codes a surface's routes return
 * that need copy more specific than the generic permission / not-found /
 * conflict / validation / rate-limit / session messages. Codes come from the
 * route handlers named beside each map — re-read them when a route changes.
 */
export * from './error-code-key-maps';

import type { ErrorCodeKeys } from '../localize-error';

/**
 * Brand Presence API (`brandPresenceRequest` → `BrandPresenceRequestError`):
 * mutation toasts (`useMutationErrorToast`) and the add-brand discovery.
 * `BRAND_PRESENCE_BRAND_LIMIT` is the 409 from `brandPresenceBrandLimit`
 * (`app/api/brand-presence/shared/helpers.ts`) — capped orgs only, so the copy
 * names the two-brand cap.
 */
export const BRAND_PRESENCE_ERROR_KEYS = {
  BRAND_PRESENCE_BRAND_LIMIT: 'BrandPresence.errors.brandLimit',
} as const satisfies ErrorCodeKeys;

/**
 * Brand Identity report export (`useBrandReportCapture` rejections, read by
 * `BrandIdentityExportMenu`): the off-screen capture had nothing to lay out
 * yet, or the Brand Book model failed to build.
 */
export const BRAND_REPORT_CAPTURE_ERROR_KEYS = {
  BRAND_REPORT_NOT_READY: 'BrandReport.export.notReady',
  BRAND_REPORT_LAYOUT_FAILED: 'BrandReport.export.layoutFailed',
} as const satisfies ErrorCodeKeys;

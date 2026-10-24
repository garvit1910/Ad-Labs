import type { ErrorCodeKeys } from '../localize-error';

/**
 * Viewers may not start or cancel data syncs (`lib/auth/sync-trigger-access.ts`,
 * user decision 2026-10-12). The generic `INSUFFICIENT_ROLE` copy says "ask an
 * owner or admin for access"; the sync surfaces say who CAN run the sync.
 * Used as-is for `POST /api/jobs/sync` (manual Sync buttons, Data Sync matrix
 * rows) and spread into the cancel and Google sync maps below.
 */
export const SYNC_START_ERROR_KEYS = {
  INSUFFICIENT_ROLE: 'Common.errors.syncRoleDenied',
} as const satisfies ErrorCodeKeys;

/** `POST /api/jobs/cancel`. */
export const SYNC_JOB_CANCEL_ERROR_KEYS = {
  JOB_NOT_FOUND: 'Settings.dataSync.errors.jobNotFound',
  JOB_NOT_CANCELLABLE: 'Settings.dataSync.errors.jobNotCancellable',
  INITIAL_SYNC_NOT_CANCELLABLE: 'Settings.dataSync.errors.initialSyncNotCancellable',
  ...SYNC_START_ERROR_KEYS,
} as const satisfies ErrorCodeKeys;

/**
 * `POST /api/google-ads/sync` (`app/api/google-ads/sync/route.ts`): its 404 is
 * "no active Google Ads account for this org/account id", and a stored row with
 * no refresh token is `GOOGLE_NOT_CONNECTED`. INTERNAL_ERROR and thrown Google
 * API errors fall through to "Failed to sync Google Ads data".
 */
export const GOOGLE_SYNC_ERROR_KEYS = {
  NOT_FOUND: 'Settings.dataSync.errors.googleAccountNotFound',
  GOOGLE_NOT_CONNECTED: 'Common.errors.platformConnectionExpired',
  ...SYNC_START_ERROR_KEYS,
} as const satisfies ErrorCodeKeys;

/**
 * Synthetic codes for the sync hooks' own English error lines
 * (`hooks/sync/sync-error-messages.ts`), assigned by `describeSyncError`
 * (`components/onboarding-widget/sync-dialog-copy.ts`). A job processor's free
 * text has no code and falls back to "Sync failed".
 */
export const SYNC_PROGRESS_ERROR_KEYS = {
  SYNC_STALLED: 'OnboardingWidget.syncData.progress.stalled',
  SYNC_FAILED: 'OnboardingWidget.syncData.progress.failed',
} as const satisfies ErrorCodeKeys;

/**
 * `GET /api/organizations/[id]/synced-months`. Its 400s are request-shape
 * bugs, not something the user can fix, so they read as "could not load".
 */
export const SYNC_HISTORY_ERROR_KEYS = {
  MISSING_FIELD: 'Settings.dataSync.loadHistoryFailed',
  VALIDATION_ERROR: 'Settings.dataSync.loadHistoryFailed',
} as const satisfies ErrorCodeKeys;

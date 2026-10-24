import type { ErrorCodeKeys } from '../localize-error';

/** Spend policy settings + spend approval decide routes (403s). */
export const SPEND_CONTROLS_ERROR_KEYS = {
  SPEND_POLICY_FORBIDDEN: 'Common.errors.permissionDenied',
  SPEND_APPROVAL_FORBIDDEN: 'Common.errors.permissionDenied',
  AGENTS_CANNOT_DECIDE: 'Common.errors.permissionDenied',
} as const satisfies ErrorCodeKeys;

/**
 * An approved budget change that the platform did not apply: the decide
 * route's `execution.code` / a failed or stale approval's `error.code`
 * (`app/api/ads-manager/shared/budget-command-parts/` `fail(...)`,
 * `lib/spend-approvals/service.ts`). `*_API_ERROR` / `INTERNAL_ERROR` carry the
 * platform's own text and fall through to "the ad platform refused the change".
 */
export const SPEND_EXECUTION_ERROR_KEYS = {
  TOKEN_DECRYPT_FAILED: 'Common.errors.platformConnectionExpired',
  GOOGLE_NOT_CONNECTED: 'Common.errors.platformConnectionExpired',
  ENTITY_DELETED: 'Settings.spendControls.execution.entityDeleted',
  CAMPAIGN_BUDGET_NOT_FOUND: 'Settings.spendControls.execution.budgetNotFound',
  NOT_SUPPORTED: 'Settings.spendControls.execution.notSupported',
  UNSUPPORTED_PLATFORM: 'Settings.spendControls.execution.notSupported',
  APPROVAL_STALE: 'Settings.spendControls.conflicts.approvalStale',
  APPROVAL_EXPIRED: 'Settings.spendControls.conflicts.approvalExpired',
} as const satisfies ErrorCodeKeys;

import type { ErrorCodeKeys } from '../localize-error';

/**
 * `/api/analytics/*`: `GET chart-data` (`INVALID_DATE_RANGE`, 400 — see
 * `app/api/analytics/shared.ts`), `POST|PUT views` (`DUPLICATE_VIEW_NAME`),
 * `POST|PUT report-drafts` + `PUT schedule-drafts` (`DUPLICATE_DRAFT_NAME`),
 * `POST|PUT report-schedules` (`DUPLICATE_SCHEDULE_NAME`), all 409. Merged by
 * `components/analytics/use-error-text.ts`; other analytics render sites pass
 * it as `codeKeys`.
 */
export const ANALYTICS_ERROR_KEYS = {
  INVALID_DATE_RANGE: 'Analytics.errors.invalidDateRange',
  DUPLICATE_VIEW_NAME: 'Analytics.errors.duplicateViewName',
  DUPLICATE_DRAFT_NAME: 'Analytics.errors.duplicateDraftName',
  DUPLICATE_SCHEDULE_NAME: 'Analytics.errors.duplicateScheduleName',
} as const satisfies ErrorCodeKeys;

/**
 * `POST /api/analytics/report-schedules/test-email` (`TestReportEmailError`,
 * `lib/scheduled-reports/send-test-email.ts`), shown by the schedule editor's
 * Send test control (`schedule-settings/components/SendTestEmailRow.tsx`).
 */
export const REPORT_TEST_EMAIL_ERROR_KEYS = {
  REPORT_RENDER_FAILED: 'ReportBuilder.schedules.emailPreview.errors.renderFailed',
  EMAIL_DELIVERY_FAILED: 'ReportBuilder.schedules.emailPreview.errors.deliveryFailed',
} as const satisfies ErrorCodeKeys;

/**
 * A failed `generated_reports` row's `error_code` (`GET
 * /api/analytics/generated-reports/[reportId]`, resolved by
 * `lib/scheduled-reports/generated-report-error-code.ts`), shown by
 * `app/analytics/report-schedules/ReportHistorySheet.tsx` in every locale,
 * English included — the stored `error_message` is raw processor text.
 */
export const GENERATED_REPORT_ERROR_KEYS = {
  EMAIL_DELIVERY_FAILED: 'ReportBuilder.schedules.historySheet.errors.emailDeliveryFailed',
  NO_RECIPIENTS: 'ReportBuilder.schedules.historySheet.errors.noRecipients',
  DB_UPDATE_FAILED: 'ReportBuilder.schedules.historySheet.errors.stateUpdateFailed',
} as const satisfies ErrorCodeKeys;

/**
 * The HEADING above a failed `generated_reports` row's message in
 * `ReportHistorySheet.tsx`, chosen by the same `error_code`. The row is only
 * inserted after the PDF stage (`pipeline/persist-pdf-artifact.ts`), so every
 * failure a row can carry happened at or after delivery: never title one
 * "Generation failed". Unknown/legacy codes take the neutral
 * `failureHeading.runFailed` fallback, which claims no stage.
 */
export const GENERATED_REPORT_FAILURE_HEADING_KEYS = {
  EMAIL_DELIVERY_FAILED: 'ReportBuilder.schedules.historySheet.failureHeading.deliveryFailed',
  NO_RECIPIENTS: 'ReportBuilder.schedules.historySheet.failureHeading.deliveryFailed',
  DB_UPDATE_FAILED: 'ReportBuilder.schedules.historySheet.failureHeading.statusNotSaved',
} as const satisfies ErrorCodeKeys;

import type { ErrorCodeKeys } from '../localize-error';

/** `POST /api/organization/create` (`app/api/organization/create/responses.ts`). */
export const ORGANIZATION_CREATE_ERROR_KEYS = {
  INVALID_HIERARCHY: 'Common.errors.organization.invalidHierarchy',
  PARENT_NOT_FOUND: 'Common.errors.organization.parentNotFound',
} as const satisfies ErrorCodeKeys;

/**
 * Supabase Auth `AuthError.code` (auth-js `ErrorCode`, lib/error-codes.d.ts)
 * for the sign-in / sign-up / reset form and the change-password dialog. Wrap
 * the error with `toAuthCodedError()` (`lib/i18n/supabase-auth-error.ts`)
 * first. `invalid_credentials` stays on the generic "unable to sign in" copy in
 * every locale (including English). `LoginForm` intercepts `email_not_confirmed`
 * before this map (`Auth.emailNotConfirmed` names the address and offers a
 * resend); the entry here is only the fallback for any other surface.
 */
export const AUTH_ERROR_KEYS = {
  invalid_credentials: 'Auth.signInFailed',
  email_not_confirmed: 'Auth.signInFailed',
  user_already_exists: 'Auth.signUpExistingAccount',
  email_exists: 'Auth.signUpExistingAccount',
  weak_password: 'Auth.errors.weakPassword',
  same_password: 'Auth.errors.samePassword',
  over_request_rate_limit: 'Common.errors.rateLimited',
  over_email_send_rate_limit: 'Auth.errors.emailRateLimited',
  session_not_found: 'Common.errors.sessionExpired',
  session_expired: 'Common.errors.sessionExpired',
  refresh_token_not_found: 'Common.errors.sessionExpired',
  refresh_token_already_used: 'Common.errors.sessionExpired',
  bad_jwt: 'Common.errors.sessionExpired',
  reauthentication_needed: 'Auth.errors.reauthenticationNeeded',
  reauthentication_not_valid: 'Auth.errors.reauthenticationNeeded',
  otp_expired: 'Auth.errors.linkExpired',
  flow_state_expired: 'Auth.errors.linkExpired',
  signup_disabled: 'Auth.errors.signupDisabled',
  email_address_invalid: 'Auth.errors.emailInvalid',
  user_banned: 'Auth.errors.userBanned',
} as const satisfies ErrorCodeKeys;

/** `members/invite` and `members/invitations/[id]/resend` routes. */
export const TEAM_INVITATION_ERROR_KEYS = {
  ALREADY_MEMBER: 'Settings.organizationDashboard.teamMembers.errors.alreadyMember',
  DUPLICATE_INVITATION: 'Settings.organizationDashboard.teamMembers.errors.duplicateInvitation',
  EMAIL_SEND_FAILED: 'Settings.organizationDashboard.teamMembers.errors.emailSendFailed',
} as const satisfies ErrorCodeKeys;

/**
 * `members/[memberId]` (PATCH role, DELETE) and `members/invitations/[invitationId]`
 * (DELETE). `CANNOT_REMOVE_OWNER` is a 400, which would otherwise read as the
 * generic "information isn't valid"; DELETE_FAILED / UPDATE_FAILED /
 * INTERNAL_ERROR fall through to the toast's own fallback.
 */
export const TEAM_MEMBER_ERROR_KEYS = {
  CANNOT_REMOVE_OWNER: 'Settings.organizationDashboard.teamMembers.errors.cannotRemoveOwner',
} as const satisfies ErrorCodeKeys;

/** `agent-keys` and `agent-keys/[keyId]` routes. */
export const AGENT_KEY_ERROR_KEYS = {
  KEY_REVOKED: 'Settings.organizationDashboard.agentKeys.errors.keyRevoked',
  ALREADY_REVOKED: 'Settings.organizationDashboard.agentKeys.errors.alreadyRevoked',
} as const satisfies ErrorCodeKeys;

/** `accounts/set-primary` and `accounts/archive` routes. */
export const PLATFORM_ACCOUNT_ERROR_KEYS = {
  PRIMARY_LOCKED: 'Settings.organizationDashboard.platformAccounts.errors.primaryLocked',
  NOT_PRIMARY_ELIGIBLE: 'Settings.organizationDashboard.platformAccounts.errors.notPrimaryEligible',
} as const satisfies ErrorCodeKeys;

/**
 * `POST /api/invitations/accept` (`app/api/invitations/accept/route.ts`) for the
 * public invite pages (`app/(public)/invite/accept-invitation.ts` re-exports
 * it). `NOT_FOUND` gets the invite page's own "not found" copy instead of the
 * generic one.
 */
export const INVITATION_ACCEPT_ERROR_KEYS = {
  ALREADY_ACCEPTED: 'Public.invite.errors.alreadyAccepted',
  INVITATION_EXPIRED: 'Public.invite.errors.expired',
  ALREADY_MEMBER: 'Public.invite.errors.alreadyMember',
  NOT_FOUND: 'Public.invite.notFound.description',
} as const satisfies ErrorCodeKeys;

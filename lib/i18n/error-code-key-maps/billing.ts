import type { BillingErrorCode } from '@/lib/billing/plans';
import type { ErrorCodeKeys } from '../localize-error';

/**
 * Billing & paywall errors (`BILLING_ERROR_CODES`, `lib/billing/plans.ts`):
 * the plan-limit / trial / inactive 402s every enforced route can return
 * (`lib/billing/server/errors.ts`) and the checkout / portal / end-trial
 * 403s and 409s and the affiliate discount-code 422s (`lib/billing/stripe/errors.ts`). Typed against the full code
 * union, so a new billing code fails typecheck until it has copy. Also merged
 * into `DEFAULT_ERROR_CODE_KEYS`, so any surface that hits a plan limit
 * localizes it without passing this map.
 */
export const BILLING_ERROR_KEYS = {
  PLAN_LIMIT_REACHED: 'Billing.errors.planLimitReached',
  TRIAL_EXPIRED: 'Billing.errors.trialExpired',
  SUBSCRIPTION_INACTIVE: 'Billing.errors.subscriptionInactive',
  EXTRA_ORG_CONFIRMATION_REQUIRED: 'Billing.errors.extraOrgConfirmationRequired',
  BILLING_OWNER_REQUIRED: 'Billing.errors.ownerRequired',
  BILLING_NOT_CONFIGURED: 'Billing.errors.notConfigured',
  BILLING_GRANDFATHERED: 'Billing.errors.grandfathered',
  BILLING_SUBSCRIPTION_EXISTS: 'Billing.errors.subscriptionExists',
  BILLING_PAYMENT_METHOD_REQUIRED: 'Billing.errors.paymentMethodRequired',
  BILLING_NOT_TRIALING: 'Billing.errors.notTrialing',
  BILLING_AGENT_NOT_ALLOWED: 'Billing.errors.agentNotAllowed',
  DISCOUNT_CODE_INVALID: 'Billing.errors.discountCodeInvalid',
  DISCOUNT_CODE_SELF_REFERRAL: 'Billing.errors.discountCodeSelfReferral',
} as const satisfies ErrorCodeKeys & Record<BillingErrorCode, string>;

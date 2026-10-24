/**
 * Billing plans and limits — the single source of truth for what each plan allows.
 *
 * Client-safe: zero imports. Server code (entitlements, enforcement, Stripe) and UI
 * (usage meters, upgrade prompts) both read from here. Product decisions of record:
 * `tasks/billing-paywall-plan.md`.
 */

export const BILLING_PLANS = ['trial', 'paid', 'grandfathered'] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

/**
 * Account status. `trialing` covers both the 7-day no-card trial and the 30-day
 * card-on-file trial (`hasPaymentMethod` tells them apart). `past_due` keeps access
 * while Stripe retries the charge; `expired` (trial ended, no card) and `canceled`
 * lock the account.
 */
export const BILLING_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'expired',
  'grandfathered',
] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const LOCKED_BILLING_STATUSES: readonly BillingStatus[] = ['canceled', 'expired'];

export const LIMITED_FEATURES = [
  'organizations',
  'competitors',
  'brand_presence_brands',
  'brand_identity_reports',
  'creative_images',
  'ask_agent_runs',
  'ask_chat_messages',
] as const;
export type LimitedFeature = (typeof LIMITED_FEATURES)[number];

/**
 * `account` limits count across every org the billing owner owns; `org` limits are
 * per organization on the paid plan. A trial shares EVERY limit across the owner's
 * orgs (see `limitScopeFor`). `total` limits never reset; `period` limits reset at
 * the start of each billing period (the trial start during a trial).
 */
export const FEATURE_LIMIT_SCOPE: Record<LimitedFeature, { scope: 'account' | 'org'; window: 'total' | 'period' }> = {
  organizations: { scope: 'account', window: 'total' },
  competitors: { scope: 'org', window: 'total' },
  brand_presence_brands: { scope: 'org', window: 'total' },
  brand_identity_reports: { scope: 'org', window: 'total' },
  creative_images: { scope: 'org', window: 'period' },
  ask_agent_runs: { scope: 'org', window: 'period' },
  ask_chat_messages: { scope: 'org', window: 'period' },
};

type LimitedPlan = Exclude<BillingPlan, 'grandfathered'>;

/**
 * Where a limit is counted for `plan`. A trial may create any number of orgs, and
 * they all share one allowance, so every trial limit counts across the owner's
 * orgs. The paid plan counts per org, except `organizations`.
 */
export function limitScopeFor(plan: BillingPlan, feature: LimitedFeature): 'account' | 'org' {
  return plan === 'trial' ? 'account' : FEATURE_LIMIT_SCOPE[feature].scope;
}

/**
 * Hard limits per plan; `null` = unlimited. For `paid`, `organizations` is the number
 * INCLUDED in the base price; each org beyond it is billed at `EXTRA_ORG_PRICE_CENTS`
 * rather than refused. A trial has unlimited orgs that share its other limits.
 * Grandfathered accounts have no limits.
 */
export const PLAN_LIMITS = {
  trial: {
    organizations: null,
    competitors: 5,
    brand_presence_brands: 1,
    brand_identity_reports: 1,
    creative_images: 5,
    ask_agent_runs: 5,
    ask_chat_messages: 100,
  },
  paid: {
    organizations: 3,
    competitors: 10,
    brand_presence_brands: 1,
    brand_identity_reports: 1,
    creative_images: 20,
    ask_agent_runs: 5,
    ask_chat_messages: 100,
  },
} satisfies Record<LimitedPlan, Record<LimitedFeature, number | null>>;

/** Features that are allowlist-gated today and that trial/paid plans switch on. */
export const PLAN_GATED_FEATURES = ['brand_presence', 'brand_identity', 'creative_studio', 'agent_mode'] as const;
export type PlanGatedFeature = (typeof PLAN_GATED_FEATURES)[number];

export const BASE_PRICE_CENTS = 14999;
export const EXTRA_ORG_PRICE_CENTS = 4999;
export const BILLING_CURRENCY = 'usd';

export const TRIAL_DAYS_WITHOUT_CARD = 7;
/** Adding a card at any point in the trial extends it to this many days after sign-up. */
export const TRIAL_DAYS_WITH_CARD = 30;

/**
 * The currency the owner picks before Stripe Checkout. `usd` (default) turns
 * Adaptive Pricing off for the session, so Checkout charges the USD price
 * wherever the visitor is; `local` turns it on: Stripe shows and charges the
 * local currency (the customer pays Stripe's FX fee) and Adcero still receives
 * the USD price.
 */
export const CHECKOUT_CURRENCY_MODES = ['usd', 'local'] as const;
export type CheckoutCurrencyMode = (typeof CHECKOUT_CURRENCY_MODES)[number];
export const DEFAULT_CHECKOUT_CURRENCY_MODE: CheckoutCurrencyMode = 'usd';

/**
 * The trial a visitor picks on the `/signup` pricing screen. `card` sends them
 * to Stripe Checkout once the account is confirmed (30 days from sign-up);
 * `no_card` is the 7-day trial. Stored in Supabase `user_metadata` at sign-up
 * and acted on once by `POST /api/billing/start-trial`.
 */
export const SIGNUP_TRIAL_CHOICES = ['card', 'no_card'] as const;
export type SignUpTrialChoice = (typeof SIGNUP_TRIAL_CHOICES)[number];
export const DEFAULT_SIGNUP_TRIAL_CHOICE: SignUpTrialChoice = 'card';
/** `user_metadata` key holding the picked `SignUpTrialChoice`. */
export const SIGNUP_TRIAL_METADATA_KEY = 'adcero_signup_trial';
/** `user_metadata` key set (ISO time) once the sign-up trial has been started. */
export const SIGNUP_TRIAL_HANDLED_METADATA_KEY = 'adcero_signup_trial_handled_at';

/** Stripe Price lookup keys; the setup script creates prices under these keys. */
export const STRIPE_PRICE_LOOKUP_KEYS = {
  base: 'adcero_monthly_v1',
  extraOrg: 'adcero_extra_org_monthly_v1',
} as const;

export const BILLING_ERROR_CODES = {
  /** A plan limit would be exceeded by this action. HTTP 402. */
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  /** The 7-day no-card trial ended. HTTP 402. */
  TRIAL_EXPIRED: 'TRIAL_EXPIRED',
  /** The subscription was canceled or is otherwise not usable. HTTP 402. */
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  /** Creating this org adds a paid extra org; the caller must confirm the charge. HTTP 402. */
  EXTRA_ORG_CONFIRMATION_REQUIRED: 'EXTRA_ORG_CONFIRMATION_REQUIRED',
  /** Only the org owner (the billing owner) can manage billing. HTTP 403. */
  BILLING_OWNER_REQUIRED: 'BILLING_OWNER_REQUIRED',
  /** Stripe billing env is missing. HTTP 503. */
  BILLING_NOT_CONFIGURED: 'BILLING_NOT_CONFIGURED',
  /** Grandfathered accounts are never billed, so they can't check out. HTTP 409. */
  BILLING_GRANDFATHERED: 'BILLING_GRANDFATHERED',
  /** A live subscription already exists; manage it in the portal. HTTP 409. */
  BILLING_SUBSCRIPTION_EXISTS: 'BILLING_SUBSCRIPTION_EXISTS',
  /** The action needs a card on file (portal, end trial). HTTP 409. */
  BILLING_PAYMENT_METHOD_REQUIRED: 'BILLING_PAYMENT_METHOD_REQUIRED',
  /** Ending the trial early needs a subscription that is still trialing. HTTP 409. */
  BILLING_NOT_TRIALING: 'BILLING_NOT_TRIALING',
  /** Money-moving billing actions are human-only (no API keys or agent surfaces). HTTP 403. */
  BILLING_AGENT_NOT_ALLOWED: 'BILLING_AGENT_NOT_ALLOWED',
  /** The affiliate discount code is unknown, malformed or paused. HTTP 422. */
  DISCOUNT_CODE_INVALID: 'DISCOUNT_CODE_INVALID',
  /** An affiliate can't use their own discount code. HTTP 422. */
  DISCOUNT_CODE_SELF_REFERRAL: 'DISCOUNT_CODE_SELF_REFERRAL',
} as const;
export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[keyof typeof BILLING_ERROR_CODES];

export interface FeatureUsage {
  /** `null` = unlimited. */
  limit: number | null;
  used: number;
}

/** What one organization may do right now; embedded in the client org bootstrap. */
export interface OrgEntitlements {
  organizationId: string;
  billingOwnerUserId: string;
  plan: BillingPlan;
  status: BillingStatus;
  /** True when the account is locked to the paywall (expired trial, canceled). */
  locked: boolean;
  /** False while `BILLING_ENFORCEMENT_ENABLED` is off: limits are reported but not enforced. */
  enforced: boolean;
  hasPaymentMethod: boolean;
  trialEndsAt: string | null;
  /** Start of the window that `period` limits count from (ISO). */
  periodStart: string | null;
  periodEnd: string | null;
  /** Plan-gated features this org can open (grandfathered orgs fall back to the existing allowlists). */
  features: Record<PlanGatedFeature, boolean>;
  usage: Record<LimitedFeature, FeatureUsage>;
}

export function planLimit(plan: BillingPlan, feature: LimitedFeature): number | null {
  if (plan === 'grandfathered') return null;
  return PLAN_LIMITS[plan][feature];
}

export function isLockedStatus(status: BillingStatus): boolean {
  return LOCKED_BILLING_STATUSES.includes(status);
}

/**
 * Whether the org's plan includes the Daily Digest — a paid-plan feature since
 * 2026-10-19: an enforced trial (card or no card) and a locked account don't get
 * one; paid and grandfathered orgs do. FAILS OPEN: unknown entitlements (`null`,
 * a failed billing read) or enforcement off count as included, like every other
 * billing read. The digest cron and the dashboard card both read this one rule.
 */
export function planIncludesDailyDigest(
  entitlements: Pick<OrgEntitlements, 'plan' | 'locked' | 'enforced'> | null,
): boolean {
  if (!entitlements || !entitlements.enforced) return true;
  if (entitlements.plan === 'grandfathered') return true;
  return entitlements.plan === 'paid' && !entitlements.locked;
}

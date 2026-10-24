/**
 * OpenAI **Flex processing** (`service_tier: 'flex'`) — WS-4 of
 * `tasks/llm-cost-optimization-plan.md`.
 *
 * Flex bills input + output at the Batch rate (50% off) on the *synchronous*
 * API in exchange for lower scheduling priority: a flex request can queue
 * longer, and when capacity is exhausted OpenAI returns HTTP 429 with error
 * code `resource_unavailable` — **the un-served request is not charged**. The
 * fallback is caller-implemented; ours lives in `clients/openai.ts`, which
 * retries the same request once with the tier stripped (standard).
 *
 * Eligibility (verified 2026-08-03): the whole gpt-5.x family (5.4, 5.4-mini,
 * 5.4-nano, 5.5). NOT gpt-4o / gpt-4o-mini / the 4.1 family / embeddings —
 * sending the field to an ineligible model is a request error, so only add it
 * at a call site whose model is 5.x.
 *
 * The LATENCY rule: opt in ONLY where no human is waiting on the response
 * (queue jobs, cron). Interactive paths — Agent Mode chat, legacy chat, any
 * request-scoped button — must never send it.
 */

/** The literal sent on the wire. */
export const FLEX_SERVICE_TIER = 'flex' as const;

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * Kill switch. **Default ON** (unset/empty/anything else); `LLM_FLEX_TIER` set
 * to `0`/`false`/`off`/`no` (case-insensitive) turns every opted-in call site
 * back into a byte-identical standard-tier request.
 *
 * Read at CALL time, never cached in a module const, so it can be stubbed in
 * tests and flipped without a redeploy.
 */
export function isFlexTierEnabled(): boolean {
  const raw = process.env.LLM_FLEX_TIER?.trim().toLowerCase();
  return !(raw && DISABLED_VALUES.has(raw));
}

/**
 * Spread into an OpenAI request body at an opted-in background call site:
 * `{ model, messages, ...flexServiceTier() }`. Returns `{}` when the kill
 * switch is off, so the serialized body is byte-identical to the pre-flex one.
 */
export function flexServiceTier(): { service_tier: typeof FLEX_SERVICE_TIER } | Record<string, never> {
  return isFlexTierEnabled() ? { service_tier: FLEX_SERVICE_TIER } : {};
}

/**
 * Option-shaped variant for call paths that thread a tier through a typed
 * options object instead of spreading into a body (the agent Responses
 * adapter). `undefined` when the kill switch is off — the adapter omits the
 * field entirely rather than sending `service_tier: undefined`.
 */
export function flexServiceTierValue(): typeof FLEX_SERVICE_TIER | undefined {
  return isFlexTierEnabled() ? FLEX_SERVICE_TIER : undefined;
}

/** True when a request body is asking for flex processing. */
export function bodyUsesFlexTier(body: Record<string, unknown>): boolean {
  return body.service_tier === FLEX_SERVICE_TIER;
}

/**
 * Copy of `body` with `service_tier` removed — the standard-tier downgrade used
 * by the capacity fallback. Deleting the key (rather than setting `'default'`)
 * keeps the retry byte-identical to a never-flex request.
 */
export function stripServiceTier<T extends Record<string, unknown>>(body: T): T {
  if (!('service_tier' in body)) return body;
  const { service_tier: _dropped, ...rest } = body;
  return rest as T;
}

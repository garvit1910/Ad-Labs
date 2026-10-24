/**
 * Deterministic post-generation copy guards. PURE — and deliberately no LLM
 * provider, so a caller that only needs the GUARDS does not drag
 * `@/lib/ai/provider` in behind them.
 *
 * Extracted from `brand-copy.ts` 2026-08-27 (Workstream H): the report card's
 * response parser reuses `findUngroundedNumerals` to enforce "every number the
 * model writes came from the pack". `brand-copy.ts` re-exports both functions,
 * so every existing import path keeps working (the repo's barrel/wrapper rule
 * for a split module).
 *
 * 2026-10-01: the implementation moved to the zero-import, client-safe
 * `brand-check/grounding.ts` (shared with the stateless brand check). This
 * file is now the thin wrapper that keeps the original import path.
 */
export { findBannedPhrases, findUngroundedNumerals } from '../brand-check/grounding';

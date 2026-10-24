/**
 * Every Creative Studio model-role resolver, in ONE zero-import module.
 *
 * Each resolver reads exactly its OWN env var at CALL time (never at import
 * time) and falls back to its pinned default. They used to live privately in
 * the modules that call them (brand-copy, rsa-copy, ranking, judge-gate, the
 * two image providers); they moved here so the generation-profile registry
 * (`lib/creative-engine/profiles/`, client-safe) can read the SAME functions
 * without importing those modules' server-only dependency graphs
 * (`@/lib/ai/provider` → `@/lib/llm/clients` → `node:async_hooks`). The
 * original modules re-export their resolver, so every existing import path
 * keeps working and there is still exactly one resolver per role.
 *
 * NO fallback chains between roles — ever. Env cross-chaining is what put a
 * gpt-5.x reasoning model on a Chat-Completions seam and 400'd every RSA
 * candidate in prod (the 2026-07-07 incident class).
 */

import { LLM_MODEL_ROLES, modelForRole } from '@/lib/llm/model-roles';

// ── Brand copy (generation/brand-copy.ts) ────────────────────────────────────

/**
 * Brand copywriter model, pinned by env (CREATIVE_BRAND_COPY_MODEL).
 *
 * MUST be a Chat-Completions-compatible model: this path calls the LLM through
 * the `getLLMProvider('openai').complete` seam, which sends plain Chat
 * Completions with `max_tokens` + `temperature` + `response_format:json_object`
 * (no param remap). gpt-5-class reasoning models REJECT that shape — chaining
 * `CREATIVE_RANK_JUDGE_MODEL` here is exactly the failure that 400'd every RSA
 * candidate in prod on 2026-07-07, so this resolver deliberately has NO
 * judge-provider/model fallback chain.
 *
 * gpt-4o since the 2026-08-04 quality rework: the mini tier produced the
 * generic retail-speak the copy guards exist to catch.
 */
export const DEFAULT_BRAND_COPY_MODEL = LLM_MODEL_ROLES.creative_brand_copy.default;

export function resolveBrandCopyModel(): string {
  return modelForRole('creative_brand_copy');
}

// ── Google RSA copy (generation/rsa-copy.ts) ─────────────────────────────────

/**
 * RSA copywriter model, pinned by env (CREATIVE_RSA_COPY_MODEL).
 *
 * MUST be a Chat-Completions-compatible model: this path calls the LLM through
 * the `getLLMProvider('openai').complete` seam, which sends plain Chat
 * Completions with `max_tokens` + `temperature` + `response_format:json_object`
 * (`lib/ai/provider.ts` → `openAIChatCompletion`, no param remap). gpt-5-class
 * models are reasoning-tier — they are driven via the Responses API with
 * `reasoning.effort`/`max_completion_tokens` (see `lib/agent/models/registry.ts`)
 * and REJECT the `max_tokens`/free-`temperature` Chat Completions shape. The old
 * default (and the `CREATIVE_RANK_JUDGE_MODEL` fallback, which points at the
 * judge's gpt-5.x model) 400'd on every candidate in prod — invisible because
 * the run-summary accounting hid the failures (fixed in `rsa-copy-run.ts`) and
 * because the shared ranking judge masks the identical failure with its
 * heuristic fallback. `gpt-4o-mini` is the proven Chat-Completions JSON tier
 * (the ad-library labeler uses this exact seam). Do NOT chain the judge model
 * here — decouple RSA copy from the judge's reasoning-model choice.
 */
export const DEFAULT_RSA_COPY_MODEL = LLM_MODEL_ROLES.creative_rsa_copy.default;

export function resolveRsaCopyModel(): string {
  return modelForRole('creative_rsa_copy');
}

// ── Judge gate (generation/judge-gate.ts) ────────────────────────────────────

/**
 * Judge model, pinned by env (CREATIVE_JUDGE_GATE_MODEL).
 *
 * MUST be a Chat-Completions-compatible VISION model — this path posts
 * image_url content parts + strict json_schema to /v1/chat/completions.
 * Deliberately NO fallback chain to the rank-judge model (gpt-5.x reasoning
 * models 400 on this shape — the 2026-07-07 RSA prod incident class).
 * gpt-4o since judge v2 (2026-08-04): the mini tier missed fidelity failures
 * like stripped packaging logos; the judge now also compares against the
 * real product reference image, which needs the stronger vision tier.
 */
export const DEFAULT_JUDGE_GATE_MODEL = LLM_MODEL_ROLES.creative_judge_gate.default;

export function resolveJudgeGateModel(): string {
  return modelForRole('creative_judge_gate');
}

// ── Ranking judges (generation/ranking.ts) ───────────────────────────────────

/**
 * TEXT rank-judge model, pinned by env (CREATIVE_RANK_JUDGE_MODEL) — used only
 * by imageless callers (Google RSA copy runs).
 * `gpt-5.4-mini` was catalog-verified in the live /v1/models listing by the
 * agent-harness work (2026-06-28, lib/agent/models/registry.ts) — the cheap
 * tool-calling tier ($0.75/$4.50 per Mtok), right-sized for a rubric-bound
 * JSON ranking call. It runs through `getLLMProvider().complete`, never a
 * Chat-Completions vision seam.
 */
export const DEFAULT_RANK_JUDGE_MODEL = LLM_MODEL_ROLES.creative_rank_judge.default;

export function resolveRankJudgeModel(): string {
  return modelForRole('creative_rank_judge');
}

/**
 * Vision judge model, pinned by env (CREATIVE_RANK_JUDGE_VISION_MODEL).
 *
 * MUST be a Chat-Completions-compatible VISION model — this path posts
 * image_url content parts + strict json_schema to /v1/chat/completions.
 * Deliberately NO fallback chain to CREATIVE_RANK_JUDGE_MODEL or
 * CREATIVE_JUDGE_GATE_MODEL: env cross-chaining is what put a gpt-5.x
 * reasoning model on a Chat-Completions seam and 400'd every call in prod
 * (2026-07-07 RSA incident class). Each seam reads exactly its OWN env var.
 */
export const DEFAULT_RANK_JUDGE_VISION_MODEL = LLM_MODEL_ROLES.creative_rank_judge_vision.default;

export function resolveRankJudgeVisionModel(): string {
  return modelForRole('creative_rank_judge_vision');
}

// ── Image providers (generation/providers/{openai,google}-image.ts) ──────────

/**
 * Default model VERIFIED 2026-07-02 against the official OpenAI docs
 * (developers.openai.com/api/docs/guides/image-generation): `gpt-image-2` is
 * the current-generation image model; `gpt-image-1.5`/`gpt-image-1`/
 * `gpt-image-1-mini` remain available as legacy ids. Still env-pinned
 * (CREATIVE_IMAGE_OPENAI_MODEL) because image model ids and pricing churn —
 * re-verify on any default change.
 */
export const DEFAULT_OPENAI_IMAGE_MODEL = LLM_MODEL_ROLES.creative_image_openai.default;

export function resolveOpenAIImageModel(): string {
  return modelForRole('creative_image_openai');
}

/**
 * Default model VERIFIED 2026-07-02 against the official Gemini API docs
 * (ai.google.dev/gemini-api/docs/image-generation): `gemini-3.1-flash-image`
 * ("Nano Banana 2", the generalist workhorse — up to 10 object reference
 * images + native aspect ratios incl. 4:5/9:16/16:9; ~$0.067 per 1K image).
 * `gemini-2.5-flash-image` is legacy with a migration recommendation. Still
 * env-pinned (CREATIVE_IMAGE_GOOGLE_MODEL) — Google hard-deletes retired
 * Gemini ids (a stale id 404s at call time), so re-verify on any change.
 */
export const DEFAULT_GOOGLE_IMAGE_MODEL = LLM_MODEL_ROLES.creative_image_google.default;

export function resolveGoogleImageModel(): string {
  return modelForRole('creative_image_google');
}

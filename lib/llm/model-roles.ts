/**
 * Every generator model the app calls, by ROLE — the one place a model id is
 * chosen. Each role reads its env var (trimmed; empty counts as unset), then an
 * optional fallback role, then its default. Zero imports, so client-safe code,
 * scripts and the model benchmark (`lib/llm/benchmark/`) can enumerate roles
 * without pulling a client graph.
 *
 * Changing a model = setting the role's env var (or editing its default here).
 * Never hard-code a model id at a call site: `tests/unit/lib/llm/model-roles.test.ts`
 * scans production source for model-id literals outside the allowlisted files.
 *
 * Not here on purpose:
 * - Agent Mode and the features that run on an agent model PROFILE (Daily
 *   Digest, the four AI Summaries): `lib/agent/models/feature-profiles.ts`.
 * - Embedding models: a change invalidates every stored vector, so they stay
 *   constants beside their stores (`services/ad-library/embeddings.ts`,
 *   `lib/agent/memory/embeddings.ts`, `lib/knowledge-base/search.ts`).
 *
 * Model choices and shutdown dates: `docs/unit-economics.md`,
 * `tasks/model-benchmark-design.md`.
 */

export type ModelProvider = 'openai' | 'gemini';

export interface ModelRoleDefinition {
  /** Environment variable that overrides the model. */
  env: string;
  /** Model id used when neither the env var nor the fallback role is set. */
  default: string;
  provider: ModelProvider;
  /** Another role (by id) whose resolution is used when this role's env var is unset. */
  fallbackRole?: string;
  /** What the role does, for the benchmark and for reviewers. */
  description: string;
  /**
   * Reasoning effort sent when the resolved model is a reasoning model
   * (`reasoningParamsForRole`). Omitted → the API's own default. A non-reasoning
   * model (e.g. an env rollback to gpt-4o-mini) never receives it: it would 400.
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

/** Google's general-purpose default (GA, multimodal, supports googleSearch). */
export const GEMINI_GENERAL_DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Used only by `lib/ai/provider.ts` when a caller passes no model. Every
 * production caller passes its role's model.
 */
export const OPENAI_PROVIDER_FALLBACK_MODEL = 'gpt-4o-mini';

export const LLM_MODEL_ROLES = {
  // ── Ask Adcero and help ────────────────────────────────────────────────
  // gpt-6-luna (effort none) since 2026-10-20, on the owner's decision from the round-2
  // benchmark (tasks/benchmarks/ask-chat-2026-10/results.md): Opus non-loss 92%, data
  // looked up when needed 48/49 vs gpt-4o's 25/49, about 2% of the cost. On Chat
  // Completions gpt-6 models accept function tools only at effort 'none'.
  ask_chat: { env: 'AI_CHAT_MODEL', default: 'gpt-6-luna', provider: 'openai', reasoningEffort: 'none', description: 'Ask Adcero legacy chat (streaming, tools)' },
  gemini_search: { env: 'GEMINI_SEARCH_MODEL', default: GEMINI_GENERAL_DEFAULT_MODEL, provider: 'gemini', description: 'gemini_search grounded web search tool' },
  help_widget_chat: { env: 'WIDGET_CHAT_MODEL', default: 'gpt-4o-mini', provider: 'openai', description: 'Help widget knowledge-base chat' },

  // ── Policy ──────────────────────────────────────────────────────────────
  policy_analyzer: { env: 'POLICY_ANALYZER_MODEL', default: 'gpt-4o', provider: 'openai', description: 'Rejected-ad policy analysis (text + image passes)' },
  policy_analyzer_video: { env: 'POLICY_ANALYZER_VIDEO_MODEL', default: GEMINI_GENERAL_DEFAULT_MODEL, provider: 'gemini', description: 'Rejected-ad policy analysis (video pass)' },
  policy_check: { env: 'POLICY_CHECK_MODEL', default: 'gpt-4o', provider: 'openai', description: 'Pre-publish policy check (image/text)' },
  policy_check_video: { env: 'POLICY_CHECK_VIDEO_MODEL', default: GEMINI_GENERAL_DEFAULT_MODEL, provider: 'gemini', description: 'Pre-publish policy check (video)' },

  // ── Task-runner generators ─────────────────────────────────────────────
  ad_copy: { env: 'AD_COPY_MODEL', default: 'gpt-4o', provider: 'openai', description: 'Ad copy generation (vision input)' },
  ad_copy_video: { env: 'AD_COPY_VIDEO_MODEL', default: GEMINI_GENERAL_DEFAULT_MODEL, provider: 'gemini', description: 'Ad copy generation from video' },
  google_assets: { env: 'GOOGLE_ASSETS_MODEL', default: 'gpt-4o', provider: 'openai', description: 'Google Ads asset generation' },
  google_description: { env: 'GOOGLE_DESCRIPTION_MODEL', default: 'gpt-4o-mini', provider: 'openai', description: 'Google Ads description suggestions' },
  analytics_descriptions: { env: 'ANALYTICS_DESCRIPTIONS_MODEL', default: 'gpt-4o-mini', provider: 'openai', description: 'Analytics metric descriptions' },
  report_narrative: { env: 'REPORT_NARRATIVE_MODEL', default: 'gpt-4o-mini', provider: 'openai', description: 'Report Builder narrative and callouts' },
  scheduled_report_analysis: { env: 'SCHEDULED_REPORT_MODEL', default: 'gpt-4o-mini', provider: 'openai', description: 'Scheduled report AI analysis' },

  // ── Brand summary, Brand Identity, Brand Object ─────────────────────────
  brand_summary: { env: 'BRAND_SUMMARY_MODEL', default: 'gpt-4o', provider: 'openai', description: 'Brand summary generation' },
  brand_colors: { env: 'BRAND_COLOR_MODEL', default: 'gpt-4o', provider: 'openai', fallbackRole: 'brand_summary', description: 'Brand palette extraction' },
  suggest_competitors: { env: 'BRAND_IDENTITY_SUGGEST_MODEL', default: 'gpt-5.4-mini', provider: 'openai', description: 'Competitor suggestions' },
  industry_classifier: { env: 'ADLIB_INDUSTRY_MODEL', default: 'gpt-4o-mini', provider: 'openai', description: 'Competitor / org industry classification' },
  brand_object_identity: { env: 'BRAND_OBJECT_IDENTITY_MODEL', default: 'gpt-5.4', provider: 'openai', description: 'Brand Object identity extraction' },
  brand_object_personas: { env: 'BRAND_OBJECT_PERSONA_MODEL', default: 'gpt-5.4', provider: 'openai', description: 'Brand Object persona generation' },

  // ── Ad labelling ────────────────────────────────────────────────────────
  // gpt-6-luna (effort none) since 2026-10-20: 80% vs 66% field accuracy against an Opus+Gemini
  // reference at 34% of the cost (tasks/benchmarks/ad-label-2026-10/results.md).
  ad_label: { env: 'ADLIB_LABEL_MODEL', default: 'gpt-6-luna', provider: 'openai', reasoningEffort: 'none', description: 'Ad-library and own-ad vision labelling' },
  ad_video_label: { env: 'ADLIB_VIDEO_LABEL_MODEL', default: GEMINI_GENERAL_DEFAULT_MODEL, provider: 'gemini', description: 'Ad-library and own-ad video labelling' },

  // ── Brand Presence ──────────────────────────────────────────────────────
  brand_presence: { env: 'BRAND_PRESENCE_LLM_MODEL', default: 'gpt-5.4-mini', provider: 'openai', description: 'Brand Presence discovery, subreddits, relevance stage 1, themes' },
  brand_presence_relevance: { env: 'BRAND_PRESENCE_RELEVANCE_MODEL', default: 'gpt-5.4', provider: 'openai', description: 'Brand Presence relevance stage 2 (escalation)' },
  brand_presence_extract: { env: 'BRAND_PRESENCE_EXTRACT_MODEL', default: 'gpt-5.4-mini', provider: 'openai', fallbackRole: 'brand_presence', description: 'Brand Presence insight + phrase extraction' },

  // ── Translation and decide() ────────────────────────────────────────────
  ai_translation: { env: 'AI_TRANSLATE_MODEL', default: 'gpt-5.4-mini', provider: 'openai', description: 'AI output translation into es/fr/de/pt/it' },
  decide: { env: 'LLM_DECIDE_MODEL', default: 'gpt-4o-mini', provider: 'openai', description: 'decide() calibrated classification (eval-only today)' },

  // ── Creative engine ─────────────────────────────────────────────────────
  creative_brand_copy: { env: 'CREATIVE_BRAND_COPY_MODEL', default: 'gpt-4o', provider: 'openai', description: 'Creative brand copywriting' },
  creative_rsa_copy: { env: 'CREATIVE_RSA_COPY_MODEL', default: 'gpt-4o-mini', provider: 'openai', description: 'Google RSA copywriting' },
  creative_judge_gate: { env: 'CREATIVE_JUDGE_GATE_MODEL', default: 'gpt-4o', provider: 'openai', description: 'Vision judge gate against the product reference' },
  creative_rank_judge: { env: 'CREATIVE_RANK_JUDGE_MODEL', default: 'gpt-5.4-mini', provider: 'openai', description: 'Text ranking judge' },
  creative_rank_judge_vision: { env: 'CREATIVE_RANK_JUDGE_VISION_MODEL', default: 'gpt-4o-mini', provider: 'openai', description: 'Vision ranking judge' },
  creative_image_openai: { env: 'CREATIVE_IMAGE_OPENAI_MODEL', default: 'gpt-image-2', provider: 'openai', description: 'OpenAI image generation leg' },
  creative_image_google: { env: 'CREATIVE_IMAGE_GOOGLE_MODEL', default: 'gemini-3.1-flash-image', provider: 'gemini', description: 'Google image generation leg' },
} as const satisfies Record<string, ModelRoleDefinition>;

export type ModelRole = keyof typeof LLM_MODEL_ROLES;

export const MODEL_ROLE_IDS = Object.keys(LLM_MODEL_ROLES) as ModelRole[];

type EnvLike = Record<string, string | undefined>;

function readEnv(env: EnvLike, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * The model for `role`: its env var, else its fallback role's resolution, else
 * its default. Throws on an unknown role so a typo can never silently pick a
 * default.
 */
export function modelForRole(role: ModelRole, env: EnvLike = process.env): string {
  const definition: ModelRoleDefinition | undefined = (LLM_MODEL_ROLES as Record<string, ModelRoleDefinition>)[role];
  if (!definition) {
    throw new Error(`Unknown model role "${String(role)}". Known roles: ${MODEL_ROLE_IDS.join(', ')}`);
  }
  const fromEnv = readEnv(env, definition.env);
  if (fromEnv) return fromEnv;
  if (definition.fallbackRole) return modelForRole(definition.fallbackRole as ModelRole, env);
  return definition.default;
}

/** Which env var overrides `role` (for docs, the benchmark runner and error messages). */
export function envVarForRole(role: ModelRole): string {
  return LLM_MODEL_ROLES[role].env;
}

/** OpenAI reasoning models (gpt-5.x, gpt-6.x, o-series) accept `reasoning_effort`; older chat models reject it. */
export function isOpenAIReasoningModel(model: string): boolean {
  return /^(gpt-5|gpt-6|o\d)/.test(model);
}

/**
 * Chat Completions params for `role`'s reasoning effort, given the model actually
 * resolved for it: `{ reasoning_effort }` for a reasoning model with an effort
 * set on the role, `{}` otherwise.
 */
export function reasoningParamsForRole(role: ModelRole, model: string): { reasoning_effort?: string } {
  const effort = (LLM_MODEL_ROLES as Record<string, ModelRoleDefinition>)[role]?.reasoningEffort;
  return effort && isOpenAIReasoningModel(model) ? { reasoning_effort: effort } : {};
}

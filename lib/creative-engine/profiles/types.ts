/**
 * Generation profiles — WHICH models a Creative Studio run uses, per role.
 *
 * Pure types + constants, zero runtime imports (client-safe). The registry
 * lives in `./registry.ts`; the model catalog in `./catalog.ts`.
 */

import type { CreativeImageProviderName } from '@/lib/creative-engine/generation/providers/provider-names';

export type { CreativeImageProviderName } from '@/lib/creative-engine/generation/providers/provider-names';

export interface GenerationProfileImageRole {
  provider: CreativeImageProviderName;
  model: string;
}

export interface GenerationProfile {
  id: string;
  label: string;
  /**
   * The image role. For the implicit `env` profile with an UNPINNED, multi-key
   * pool this is the FIRST provider of the fan-out, and `imagePoolMixed` is
   * true — the run round-robins across every keyed provider.
   */
  image: GenerationProfileImageRole;
  /**
   * True only for the `env` profile when `CREATIVE_IMAGE_PROVIDER` is unpinned
   * and more than one provider is keyed (the pipeline fans candidates out
   * across all of them). Always false for named profiles.
   */
  imagePoolMixed: boolean;
  brandCopyModel: string;
  rsaCopyModel: string;
  judgeGateModel: string;
  rankJudgeModel: string;
  rankJudgeVisionModel: string;
  rendererVersions: { copy: number; image: number; judge: number };
  /**
   * True when every model id (every pool provider's image model + all five
   * text roles) is in the catalog. A named profile's IMAGE model is validated
   * at construction; its text roles come from env and are checked honestly.
   */
  catalogVerified: boolean;
  /** Whether a LIVE (paid) run can execute: the image provider's API key is set. */
  liveRunnable: boolean;
  /** Why `liveRunnable` is false — names the missing env var. */
  liveBlockedReason?: string;
}

/**
 * The durable per-candidate stamp written to
 * `generated_creatives.tags.generation_profile` — the profile's model roles
 * at run time, WITHOUT the environment-dependent readiness flags.
 */
export interface GenerationProfileStamp {
  id: string;
  image: GenerationProfileImageRole;
  /** Mirrors `GenerationProfile.imagePoolMixed`: the row's own `provider`/`model` columns say which pool member rendered it. */
  imagePoolMixed: boolean;
  brandCopyModel: string;
  rsaCopyModel: string;
  judgeGateModel: string;
  rankJudgeModel: string;
  rankJudgeVisionModel: string;
  rendererVersions: { copy: number; image: number; judge: number };
}

export const GENERATION_PROFILE_TAG_KEY = 'generation_profile' as const;

/** The implicit profile: every role from env — today's behaviour. */
export const ENV_GENERATION_PROFILE_ID = 'env' as const;

/** Env var selecting the default profile when a run names none. */
export const GENERATION_PROFILE_ENV_VAR = 'CREATIVE_GENERATION_PROFILE' as const;

export type GenerationProfileErrorCode =
  | 'GENERATION_PROFILE_UNKNOWN'
  | 'GENERATION_PROFILE_INVALID';

/** Structured, typed failure — `code` + `remediation` map straight to an AF error. */
export class GenerationProfileError extends Error {
  readonly code: GenerationProfileErrorCode;
  readonly remediation: string;

  constructor(code: GenerationProfileErrorCode, message: string, remediation: string) {
    super(message);
    this.name = 'GenerationProfileError';
    this.code = code;
    this.remediation = remediation;
  }
}

import type { GateResult, CreativeGenome } from '@/lib/creative-engine/generation/types';

/** An arm row as A4 writes it (spacetime/src/tables_a.ts), with `evidence` parsed. */
export interface Recipe {
  arm_id: string;
  angle: string;
  hook: string;
  strategy: string;
  rationale: string;
  evidence: string[];
}

export interface Segment {
  segment_id: string;
  name: string;
  share: number;
}

/** The client brand row (`brand.is_client`). */
export interface ClientBrand {
  brand_id: string;
  name: string;
}

/**
 * A (recipe, segment) pair the pipeline will not write, logged instead of
 * dropped. `missing` names the unmet HOOK_PRODUCIBILITY requirement, or why
 * the pair can't be built at all.
 */
export interface Skip {
  arm_id: string;
  hook: string;
  segment_id: string;
  missing: string;
}

/** A (recipe, segment) pair to write, with its compiler persona row id. */
export interface Pair {
  recipe: Recipe;
  segmentId: string;
  personaRef: string;
}

/**
 * One text-only creative: CREATIVE_MANIFEST's `TextCreative` minus id, rank and
 * intendedImagePrompt (the sim ranks, nothing renders), plus the variant index
 * and why a creative was gated out.
 */
export interface GeneratedCreative {
  briefId: string;
  /** The compiler persona row id (`persona_<slug>`). */
  segment: string;
  arm: { angleUniversal: string; hookArchetype: string; key: string };
  format: string;
  variant: number;
  headline: string;
  primaryText: string;
  cta: string;
  visualDescription: string;
  visualDescriptionSource: 'visual_concept' | 'variation_text';
  copySource: 'llm' | 'brief_fallback';
  copyError?: { code: string; reason: string };
  copyText: string;
  gateResults: GateResult[];
  genome: CreativeGenome;
  packFingerprint: string;
  status: 'ranked' | 'gated_out';
  statusReason?: string;
}

/** A `creative` row as `upsert_creatives` takes it: A's conventions, "" for empty, json as strings. */
export interface CreativeRow {
  creative_id: string;
  arm_id: string;
  brand_id: string;
  origin: 'generated';
  headline: string;
  primary_text: string;
  cta: string;
  visual_description: string;
  image_url: string;
  landing_product_id: string;
  days_running: number;
  round_created: number;
  learning_ids: string;
  segment_id: string;
  pack_fingerprint: string;
  status: 'ranked' | 'gated_out';
}

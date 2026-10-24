/**
 * Creative genome construction + completeness validation.
 *
 * The genome rule is non-negotiable (see types.ts): every generated output
 * carries a complete `CreativeGenome` stamped AT CREATION — Phase 4
 * concept-level performance attribution and the Phase 5 anonymized industry
 * layer both depend on it. `genome_complete` is a hard gate.
 */

import type { CreativeBrief, CreativeGenome } from './types';
import { normalizeVisualStyle } from './visual-style';
import {
  enforceGenomeCompleteness,
  resolveGenomeCompleteness,
} from './genome-completeness';

/**
 * Workstream B fields (`angleUniversal`, `personaUniversal`, `format`) are
 * DELIBERATELY ABSENT from this list.
 *
 * `buildGenome` floors the universals to `'other'`, so a genome built here can
 * never lack them — but this gate also runs over genomes read straight from the
 * DB (the candidate edit / iterate / versions routes re-gate a stored genome,
 * which never passes through `buildGenome`). Every `generated_creatives` row
 * written before B lacks the fields, so requiring them would mark each of those
 * candidates `gated_out` the first time a human edited it — a hard,
 * non-repairable kill on already-paid work, and exactly the failure mode the
 * judge-gate incident taught. The gate exists to catch missing GENERATION
 * provenance; a derived accounting field with a guaranteed floor adds no safety
 * here and only creates a back-compat cliff. Caught by the candidate-route
 * suite, which went `gated_out` across the board when they were listed.
 */
const REQUIRED_GENOME_FIELDS = [
  'briefId',
  'angle',
  'persona',
  'style',
  'provider',
  'model',
] as const;

/**
 * Strategy-stamp values that drove THIS candidate. The four canonical genome
 * dimensions are resolved from here first and from prose only as a last rung —
 * see `genome-completeness.ts` for why that order is the whole point.
 */
export interface BuildGenomeStrategySources {
  /** `creative_briefs.tags.strategy.angleKey` — the selector/sampler pick. */
  angleKey?: string | null;
}

/** Stamp a genome from the brief + generation provenance. */
export function buildGenome(
  brief: CreativeBrief,
  provider: string,
  model: string,
  params: Record<string, unknown>,
  extras?: Partial<
    Pick<
      CreativeGenome,
      'hookArchetype' | 'format' | 'textOverlay' | 'rankScore' | 'judgeVersion'
    >
  >,
  strategy?: BuildGenomeStrategySources
): CreativeGenome {
  // Completeness pass (2026-09-22). Resolves angleUniversal / hookArchetype /
  // format / personaUniversal from the STRUCTURED sources that drove this
  // candidate and stamps `genomeProvenance` beside them, so an `'other'` here
  // can never be mistaken for a value the labeler would agree with.
  //
  // This runs on EVERY stamp point — the wide wave, the fulfilled re-stamp, the
  // rehydrated-seed path and the RSA copy path — because it lives in the one
  // function all of them share, and `persistCandidate` writes `candidate.genome`
  // verbatim. Loud in dev/test, structured-log + provenance in production: a
  // stamp defect is an accounting problem, never a reason to discard paid work.
  const completeness = resolveGenomeCompleteness({
    ...(strategy?.angleKey ? { angleKey: strategy.angleKey } : {}),
    ...(extras?.hookArchetype ? { hookArchetype: extras.hookArchetype } : {}),
    ...(extras?.format ? { format: extras.format } : {}),
    briefAngleUniversal: brief.angleUniversal ?? null,
    briefPersonaUniversal: brief.personaUniversal ?? null,
    angleProse: brief.angle,
    personaProse: brief.persona,
  });
  enforceGenomeCompleteness(completeness, `brief ${brief.briefId}`);
  return {
    briefId: brief.briefId,
    ...(brief.conceptId ? { conceptId: brief.conceptId } : {}),
    brandFactIds: brief.proofFactIds ?? [],
    angle: brief.angle,
    persona: brief.persona,
    // Normalize at the stamp point: guarantees an enum-valued genome even when a
    // stale persisted brief carries prose `style` (idempotent for enum values).
    // CreativeGenome.style stays typed `string` — historical jsonb rows hold
    // prose, and the backfill script converts those in place.
    style: normalizeVisualStyle(brief.style),
    provider,
    model,
    generationParams: params,
    ...extras,
    // AFTER `extras`: the completeness pass is the single authority on the four
    // canonical dimensions. An extras-supplied hook/format already fed it as the
    // strategy rung, so this re-states the SAME token when it was canonical and
    // drops an off-taxonomy one rather than letting it ride into the rollup.
    ...completeness.fields,
    genomeProvenance: completeness.provenance,
  };
}

/**
 * Validate genome completeness. Required fields must be non-empty strings:
 * briefId, angle, persona, style, provider, model.
 */
export function assertGenomeComplete(genome: CreativeGenome): {
  complete: boolean;
  missing: string[];
} {
  const missing: string[] = REQUIRED_GENOME_FIELDS.filter((field) => {
    const value = genome[field];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  return { complete: missing.length === 0, missing };
}

/**
 * Genome completeness — every generated creative must carry a canonical,
 * RESOLVABLE value on all four attribution dimensions, or say out loud that it
 * does not (Workstream B follow-up, 2026-09-22).
 *
 * WHY THIS EXISTS. The composer/labeler agreement census
 * (`tasks/creative-arena/data/label-agreement-2026-09-21.md`) measured all 24
 * real engine-generated creatives in production: 40 of the 57 label/genome
 * disagreements are the GENOME sitting on the `'other'` floor, and EVERY
 * `personaUniversal` in the corpus is `'other'`. `armsFromBeliefs`
 * (`loop/sampler.ts`) cannot tell "the composer picked the wrong cell" from
 * "the genome never stated a cell" — both credit performance to an arm the
 * composer did not pull. An unresolvable genome makes the loop learn NOTHING
 * about that ad while looking exactly like an ad it learned from.
 *
 * THE INVARIANT. At the point a genome is stamped (and therefore persisted —
 * `persistCandidate` writes `candidate.genome` verbatim), each of
 * `angleUniversal` / `hookArchetype` / `format` / `personaUniversal` either
 *   (a) holds a closed-taxonomy token sourced from the STRATEGY STAMP or the
 *       route-canonicalized brief that drove generation, or
 *   (b) is marked in `genome.genomeProvenance` as NOT a value.
 * There is no third state. `'other'` with no provenance marker — the shape the
 * census found on two thirds of the corpus — is the bug this closes.
 *
 * PROVENANCE, NOT REPAIR. Nothing here invents a value. The resolvers are the
 * SAME pure ones the briefs route uses (`canonicalize.ts`), and the strategy
 * rung reads the selector/sampler's own picked token — it never re-derives a
 * dimension from prose when a structured pick exists.
 *
 * PURE — no IO, no clock, no randomness. The only environment read is the
 * strict-mode policy (`NODE_ENV`), which decides whether a defect throws or
 * logs; the resolution itself is deterministic and env-free.
 */

import {
  ANGLES,
  FORMATS,
  HOOK_ARCHETYPES,
  PERSONAS,
  type AdFormat,
  type Angle,
  type HookArchetype,
  type Persona,
} from '@/services/ad-library/label-taxonomy';
import { universalAngleFor } from '@/lib/brand-identity/industry-taxonomy';
import {
  canonicalAngleUniversal,
  canonicalPersonaUniversal,
} from './canonicalize';

/** The four attribution dimensions the loop learns on. */
export const GENOME_CANONICAL_DIMENSIONS = [
  'angleUniversal',
  'hookArchetype',
  'format',
  'personaUniversal',
] as const;

export type GenomeCanonicalDimension =
  (typeof GENOME_CANONICAL_DIMENSIONS)[number];

/**
 * WHERE the stamped token came from — or, for the two negative markers, why
 * there is no token.
 *
 * `strategy` / `brief` / `prose` are RESOLVED: the value is a real claim about
 * this ad and the loop may learn on it.
 *
 * `unresolved` / `unmapped` are NOT VALUES. The genome still carries `'other'`
 * on the two non-optional dimensions (the `CreativeGenome` type requires them
 * and `genome_complete` is a hard, non-repairable kill gate), and omits the two
 * optional ones — but the marker is what makes that `'other'` impossible to
 * mistake for a resolved `'other'` the labeler would agree with.
 */
export type GenomeProvenanceMarker =
  /** The strategy stamp's own picked token (`angleKey` / the group's hook / format). */
  | 'strategy'
  /** The route-canonicalized brief field (`brief.angleUniversal` / `personaUniversal`). */
  | 'brief'
  /** Re-derived here from the brief prose by the canonicalizer ladder (rung ≠ `other`). */
  | 'prose'
  /** The brief GENUINELY had no source for this dimension. Legal; not a defect. */
  | 'unresolved'
  /** A source existed and did not resolve to a canonical token. A DEFECT. */
  | 'unmapped';

export type GenomeProvenance = Record<
  GenomeCanonicalDimension,
  GenomeProvenanceMarker
>;

const RESOLVED_MARKERS = new Set<GenomeProvenanceMarker>([
  'strategy',
  'brief',
  'prose',
]);

/**
 * Whether a marker means "this dimension states a real cell". The ONE predicate
 * downstream readers (rollup, sampler diagnostics, the census) should use —
 * comparing against `'other'` is not enough, because `'other'` is also a legal
 * RESOLVED label value on the imported-ad side.
 */
export function isResolvedGenomeDimension(
  marker: GenomeProvenanceMarker | undefined
): boolean {
  return marker !== undefined && RESOLVED_MARKERS.has(marker);
}

export type GenomeCompletenessDefectCode =
  /** A structured pick existed but is not a member of the closed taxonomy. */
  | 'GENOME_DIMENSION_OFF_TAXONOMY'
  /** A source existed (prose or a pick) and floored to `'other'`. */
  | 'GENOME_DIMENSION_UNMAPPED';

export interface GenomeCompletenessDefect {
  dimension: GenomeCanonicalDimension;
  code: GenomeCompletenessDefectCode;
  reason: string;
  remediation: string;
}

export interface GenomeCompletenessSources {
  /**
   * `creative_briefs.tags.strategy.angleKey` — the selector's or sampler's own
   * picked angle token. The STRONGEST rung and the only one that proves the
   * genome names the cell the engine actually pulled. Control values
   * (`explicit` / `own_prior` / `goal_blueprint`) are not vocabulary and fall
   * through, exactly as in `canonicalAngleUniversal`.
   */
  angleKey?: string | null;
  /** The candidate's strategy-group hook pick (`VariationSpec.hookArchetype`). */
  hookArchetype?: string | null;
  /** The candidate's strategy-group format pick (`VariationSpec.format`). */
  format?: string | null;
  /** `brief.angleUniversal` — the briefs route's canonicalized roll-up. */
  briefAngleUniversal?: string | null;
  /** `brief.personaUniversal` — ditto. */
  briefPersonaUniversal?: string | null;
  /** `brief.angle` prose. Both the last rung AND the "genuinely none" test. */
  angleProse?: string | null;
  /** `brief.persona` prose. Persona has NO strategy seam — prose is all there is. */
  personaProse?: string | null;
}

export interface GenomeCompletenessFields {
  angleUniversal: Angle;
  personaUniversal: Persona;
  /** Omitted (never `'other'`) when unresolved — keeps rollup's present-only filter honest. */
  hookArchetype?: HookArchetype;
  format?: AdFormat;
}

export interface GenomeCompletenessResult {
  fields: GenomeCompletenessFields;
  provenance: GenomeProvenance;
  defects: GenomeCompletenessDefect[];
}

const ANGLE_SET = new Set<string>(ANGLES);
const PERSONA_SET = new Set<string>(PERSONAS);
const HOOK_SET = new Set<string>(HOOK_ARCHETYPES);
const FORMAT_SET = new Set<string>(FORMATS);

/** Control values `canonicalAngleUniversal` also refuses to treat as vocabulary. */
const ANGLE_KEY_CONTROL_VALUES = new Set([
  'explicit',
  'own_prior',
  'goal_blueprint',
]);

function trimmed(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/**
 * A stamped token is only a real claim when it is a taxonomy member that is not
 * the `'other'` floor. `'other'` IS a legal member for ACCOUNTING (the labeler
 * emits it freely), which is precisely why it can never double as "resolved"
 * on the genome side without a provenance marker beside it.
 */
function statedToken(value: string | null | undefined, set: Set<string>): string | null {
  const token = trimmed(value).toLowerCase();
  if (token.length === 0 || token === 'other') return null;
  return set.has(token) ? token : null;
}

/* ── Optional visual dimensions (hook, format) ───────────────────────────── */

function resolveStrategyDimension<T extends string>(
  dimension: GenomeCanonicalDimension,
  picked: string | null | undefined,
  set: Set<string>
): { value?: T; marker: GenomeProvenanceMarker; defect?: GenomeCompletenessDefect } {
  const raw = trimmed(picked);
  // No strategy stamp / no group pick — the brief genuinely had none. Legal:
  // copy-only (Google RSA) runs and pre-strategy briefs have no visual cell.
  if (raw.length === 0) return { marker: 'unresolved' };

  const token = statedToken(raw, set);
  if (token) return { value: token as T, marker: 'strategy' };

  // A pick that is off-taxonomy (or is the `'other'` floor) reached the stamp.
  // `strategy.ts` restricts every pick to the producible allowlists, so this is
  // a wiring defect — a value fabricated or mangled between selection and stamp.
  return {
    marker: 'unmapped',
    defect: {
      dimension,
      code:
        raw.toLowerCase() === 'other'
          ? 'GENOME_DIMENSION_UNMAPPED'
          : 'GENOME_DIMENSION_OFF_TAXONOMY',
      reason: `strategy picked ${dimension}=${JSON.stringify(raw)}, which is not a stated closed-taxonomy token`,
      remediation:
        'Check the strategy stamp groups in creative_briefs.tags.strategy — every pick must come from the producible allowlists in generation/producibility.ts.',
    },
  };
}

/* ── Resolution ──────────────────────────────────────────────────────────── */

/**
 * Resolve all four dimensions from the structured sources that drove
 * generation. TOTAL — never throws, never invents. The caller decides what a
 * defect means (see `enforceGenomeCompleteness`).
 */
export function resolveGenomeCompleteness(
  sources: GenomeCompletenessSources
): GenomeCompletenessResult {
  const defects: GenomeCompletenessDefect[] = [];

  // ── angleUniversal ──────────────────────────────────────────────────────
  // Rung order: the strategy's own pick → the route's canonicalized brief field
  // → the prose ladder. Prose is LAST on purpose: re-deriving an angle from
  // prose when a structured pick exists is exactly how a genome ends up naming
  // a cell the engine never pulled.
  const angleKey = trimmed(sources.angleKey).toLowerCase();
  const angleProse = trimmed(sources.angleProse);
  let angleUniversal: Angle = 'other';
  let angleMarker: GenomeProvenanceMarker = 'unresolved';

  const fromAngleKey =
    angleKey.length > 0 && !ANGLE_KEY_CONTROL_VALUES.has(angleKey)
      ? universalAngleFor(angleKey)
      : null;
  const briefAngle = statedToken(sources.briefAngleUniversal, ANGLE_SET);
  if (fromAngleKey && fromAngleKey !== 'other') {
    angleUniversal = fromAngleKey;
    angleMarker = 'strategy';
  } else if (briefAngle) {
    angleUniversal = briefAngle as Angle;
    angleMarker = 'brief';
  } else {
    const derived = canonicalAngleUniversal({
      angle: sources.angleProse ?? null,
      ...(angleKey.length > 0 ? { angleKey } : {}),
    });
    if (derived.rung !== 'other') {
      angleUniversal = derived.value;
      angleMarker = 'prose';
    } else if (angleProse.length > 0 || angleKey.length > 0) {
      // A source EXISTED and still floored. The ladder is shy by design (a
      // wrong universal pools two unrelated arms), so the honest outcome is a
      // marked non-value, never a silent `'other'`.
      angleMarker = 'unmapped';
      defects.push({
        dimension: 'angleUniversal',
        code: 'GENOME_DIMENSION_UNMAPPED',
        reason: `angle ${JSON.stringify(angleProse.slice(0, 120))}${
          angleKey.length > 0 ? ` (angleKey=${JSON.stringify(angleKey)})` : ''
        } floored to 'other'`,
        remediation:
          'Compose through the briefs route so tags.strategy.angleKey rides the brief, or extend the canonicalize.ts ladder / industry-taxonomy roll-up for this angle.',
      });
    }
  }

  // ── personaUniversal ────────────────────────────────────────────────────
  // Persona has NO strategy seam (the sampler records the deferral verbatim:
  // `deferred.persona = 'no_strategy_seam'`), so the route's canonicalized
  // brief field and the prose ladder are the only rungs that exist.
  const personaProse = trimmed(sources.personaProse);
  let personaUniversal: Persona = 'other';
  let personaMarker: GenomeProvenanceMarker = 'unresolved';
  const briefPersona = statedToken(sources.briefPersonaUniversal, PERSONA_SET);
  if (briefPersona) {
    personaUniversal = briefPersona as Persona;
    personaMarker = 'brief';
  } else {
    const derived = canonicalPersonaUniversal({
      persona: sources.personaProse ?? null,
    });
    if (derived.rung !== 'other') {
      personaUniversal = derived.value;
      personaMarker = 'prose';
    } else if (personaProse.length > 0) {
      personaMarker = 'unmapped';
      defects.push({
        dimension: 'personaUniversal',
        code: 'GENOME_DIMENSION_UNMAPPED',
        reason: `persona ${JSON.stringify(personaProse.slice(0, 120))} floored to 'other'`,
        remediation:
          'Extend the canonicalize.ts persona ladder (keyword / age-band rungs) or give the brand-context persona row demographic language the ladder can read.',
      });
    }
    // personaProse empty → the brief genuinely carried no persona. Persona is
    // optional; `unresolved` is the sanctioned answer and NOT a defect.
  }

  // ── hookArchetype / format ──────────────────────────────────────────────
  const hook = resolveStrategyDimension<HookArchetype>(
    'hookArchetype',
    sources.hookArchetype,
    HOOK_SET
  );
  if (hook.defect) defects.push(hook.defect);
  const format = resolveStrategyDimension<AdFormat>(
    'format',
    sources.format,
    FORMAT_SET
  );
  if (format.defect) defects.push(format.defect);

  return {
    fields: {
      angleUniversal,
      personaUniversal,
      ...(hook.value ? { hookArchetype: hook.value } : {}),
      ...(format.value ? { format: format.value } : {}),
    },
    provenance: {
      angleUniversal: angleMarker,
      personaUniversal: personaMarker,
      hookArchetype: hook.marker,
      format: format.marker,
    },
    defects,
  };
}

/* ── Enforcement ─────────────────────────────────────────────────────────── */

/** Structured error shape (agent-first contract: code / reason / remediation). */
export class GenomeCompletenessError extends Error {
  readonly code = 'GENOME_DIMENSION_UNRESOLVABLE';
  readonly reason: string;
  readonly remediation: string;
  readonly defects: GenomeCompletenessDefect[];

  constructor(defects: GenomeCompletenessDefect[], context: string) {
    const reason = defects
      .map((defect) => `${defect.dimension}: ${defect.reason}`)
      .join('; ');
    super(`Genome completeness failed for ${context} — ${reason}`);
    this.name = 'GenomeCompletenessError';
    this.reason = reason;
    this.remediation = defects[0]?.remediation ?? '';
    this.defects = defects;
  }
}

/**
 * Loud in dev/test, fail-soft in production.
 *
 * Generation is PAID work and a stamp defect is an accounting problem, never a
 * reason to throw away an image the org already bought — so production logs the
 * structured defect and keeps the provenance marker, which is what makes the
 * unresolved share a query. Dev and test throw, because a defect there means
 * the structured pick is not reaching the stamp and that is a wiring bug that
 * must not ship.
 */
export function enforceGenomeCompleteness(
  result: GenomeCompletenessResult,
  context: string
): void {
  if (result.defects.length === 0) return;
  // Ad Lab: CREATIVE_GENOME_STRICT=off makes `next dev` (the agents' API) fail soft like production.
  if (process.env.NODE_ENV === 'production' || process.env.CREATIVE_GENOME_STRICT === 'off') {
    for (const defect of result.defects) {
      console.error(
        `[GenomeCompleteness] ${defect.code} ${context} ${defect.dimension}: ${defect.reason} — ${defect.remediation}`
      );
    }
    return;
  }
  throw new GenomeCompletenessError(result.defects, context);
}

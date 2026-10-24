/**
 * Brand-context brief-stamp reader — PURE (no IO). The briefs route stamps
 * `creative_briefs.tags.brandContext` at compose time (Phase 3); the
 * generation processor and the candidate edit routes read it back to detect
 * brand mode and locate the immutable pack by fingerprint.
 */

import {
  EXPERIMENT_OPPORTUNITY_KINDS,
  EXPERIMENT_SOURCE_KINDS,
  GENERATION_MODES,
  type ExperimentOpportunityKind,
  type ExperimentSelection,
  type ExperimentSourceKind,
  type GenerationMode,
} from '../generation/experiment-types';
import { BrandContextError } from './types';

/** The brief-row lineage stamp written by the briefs route (Phase 3). */
export interface BrandContextBriefStamp {
  fingerprint: string;
  brandProfileId: string;
  personaRef?: string;
  keyMessageRef?: string;
}

/**
 * Classification of a brief row's `tags.brandContext` slot.
 *
 * `none` covers BOTH sanctioned no-pack shapes — an absent slot (legacy
 * brief) and the packless full-brief stamp (`{ brandProfileId }` with no
 * fingerprint, written by the MCP/agent brief path) — because both mean
 * "generate on the legacy packless path", deliberately.
 *
 * `malformed` is the case the mandatory-brand-context invariant cares about:
 * the slot EXISTS and claims a pack (or claims nothing readable) but cannot be
 * resolved to one. Silently degrading that to the legacy path is the bug —
 * callers that spend money on generation must treat it as terminal.
 */
export type BrandStampRead =
  | { state: 'none' }
  | { state: 'valid'; stamp: BrandContextBriefStamp }
  | { state: 'malformed'; reason: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Pure classifier — the single source both readers below share. */
export function readBrandStamp(tags: unknown): BrandStampRead {
  const brandContext =
    tags && typeof tags === 'object'
      ? (tags as { brandContext?: unknown }).brandContext
      : undefined;
  if (brandContext === undefined || brandContext === null) return { state: 'none' };
  if (typeof brandContext !== 'object' || Array.isArray(brandContext)) {
    return {
      state: 'malformed',
      reason: `tags.brandContext is ${Array.isArray(brandContext) ? 'an array' : typeof brandContext}, expected an object`,
    };
  }
  const stamp = brandContext as Record<string, unknown>;
  const hasFingerprintKey = 'fingerprint' in stamp;
  const validFingerprint = nonEmptyString(stamp.fingerprint);
  const validProfile = nonEmptyString(stamp.brandProfileId);
  if (validFingerprint && validProfile) {
    return { state: 'valid', stamp: stamp as unknown as BrandContextBriefStamp };
  }
  // The sanctioned packless stamp: a brand profile, no pack claim at all.
  if (!hasFingerprintKey && validProfile) return { state: 'none' };
  const missing = [
    ...(validFingerprint ? [] : ['fingerprint']),
    ...(validProfile ? [] : ['brandProfileId']),
  ];
  return {
    state: 'malformed',
    reason: `tags.brandContext is present but unusable (missing or non-string: ${missing.join(', ')})`,
  };
}

/**
 * LENIENT reader — malformed reads as "no stamp". Used by the candidate EDIT
 * routes, which must never hard-fail a human's edit of an already-paid asset
 * on brief-metadata corruption (they degrade the judge seam instead).
 */
export function extractBrandStamp(
  tags: unknown,
): BrandContextBriefStamp | undefined {
  const read = readBrandStamp(tags);
  return read.state === 'valid' ? read.stamp : undefined;
}

/**
 * STRICT reader — used by the generation processor, where a malformed stamp
 * must NOT silently fall through to the packless legacy path (the PR's
 * "mandatory brand context — no silent fallback" invariant). Absent/packless
 * still returns undefined; malformed throws a terminal `BrandContextError`
 * that the processor stamps exactly like BRAND_CONTEXT_PACK_MISSING.
 */
export function requireBrandStamp(
  tags: unknown,
): BrandContextBriefStamp | undefined {
  const read = readBrandStamp(tags);
  if (read.state === 'malformed') {
    throw new BrandContextError(
      'BRAND_CONTEXT_STAMP_MALFORMED',
      `Brief brand-context stamp is malformed: ${read.reason}`,
      'Create a new brief — composing rewrites the brand-context stamp against the current store.',
      500,
    );
  }
  return read.state === 'valid' ? read.stamp : undefined;
}

/**
 * Strategy stamp (2026-08) — the briefs route stamps `tags.strategy` when
 * evidence-driven strategy selection ran; the processor reads the groups
 * back to build the per-candidate variation plan + per-group copy directive.
 */
export interface StrategyStampGroup {
  key: string;
  hookArchetype: string;
  format: string;
  sceneDirective: string;
  hookDirective: string;
  /** Market execution cues (2026-08) — absent on legacy stamps. */
  executionDirective?: string;
  /** Sanitized winning-ad staging notes — absent on legacy stamps. */
  executionNotes?: string;
}

export interface StrategyBriefStamp {
  angleKey: string;
  groups: StrategyStampGroup[];
  /**
   * Generation mode (experiment feature, 2026-08-18). ABSENT on every
   * pre-feature stamp — absence reads as `'iterate'`, which is what those
   * briefs were. Stamped durably so downstream segmentation
   * (performance_memory joins, loop insights, the scored-run log) can tell an
   * exploit run from an explore run without re-deriving anything.
   */
  mode?: GenerationMode;
  /** The picked opportunity's identity — present only on experiment briefs. */
  experiment?: ExperimentSelection;
}

function inList<T extends string>(
  allowed: readonly T[],
  value: unknown,
): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Whitelist read of `tags.strategy.experiment`. Every field is re-validated
 * against the shared const arrays — a stamp is untrusted jsonb that survived a
 * DB round-trip, and a half-formed selection must read as ABSENT rather than
 * flow on as a lie about provenance.
 */
function readExperimentSelection(value: unknown): ExperimentSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const kind = inList<ExperimentOpportunityKind>(
    EXPERIMENT_OPPORTUNITY_KINDS,
    raw.kind,
  );
  const sourceKind = inList<ExperimentSourceKind>(
    EXPERIMENT_SOURCE_KINDS,
    raw.sourceKind,
  );
  const angleKey = raw.angleKey;
  if (!kind || !sourceKind || !nonEmptyString(angleKey)) return undefined;
  return {
    kind,
    angleKey,
    ...(nonEmptyString(raw.format) ? { format: raw.format } : {}),
    sourceKind,
  };
}

export function extractStrategyStamp(
  tags: unknown,
): StrategyBriefStamp | undefined {
  const strategy =
    tags && typeof tags === 'object'
      ? (tags as { strategy?: unknown }).strategy
      : undefined;
  if (!strategy || typeof strategy !== 'object') return undefined;
  const stamp = strategy as Record<string, unknown>;
  if (typeof stamp.angleKey !== 'string' || !Array.isArray(stamp.groups)) {
    return undefined;
  }
  const groups: StrategyStampGroup[] = [];
  for (const entry of stamp.groups) {
    const group = entry as Record<string, unknown>;
    if (
      typeof group.key === 'string' &&
      typeof group.hookArchetype === 'string' &&
      typeof group.format === 'string'
    ) {
      groups.push({
        key: group.key,
        hookArchetype: group.hookArchetype,
        format: group.format,
        sceneDirective:
          typeof group.sceneDirective === 'string' ? group.sceneDirective : '',
        hookDirective:
          typeof group.hookDirective === 'string' ? group.hookDirective : '',
        // Conditional spreads — absent (not '') on legacy stamps so
        // pre-feature briefs round-trip byte-identical.
        ...(typeof group.executionDirective === 'string' &&
        group.executionDirective.length > 0
          ? { executionDirective: group.executionDirective }
          : {}),
        ...(typeof group.executionNotes === 'string' &&
        group.executionNotes.length > 0
          ? { executionNotes: group.executionNotes }
          : {}),
      });
    }
  }
  if (groups.length === 0) return undefined;
  const mode = inList<GenerationMode>(GENERATION_MODES, stamp.mode);
  const experiment = readExperimentSelection(stamp.experiment);
  return {
    angleKey: stamp.angleKey,
    groups,
    // Conditional spreads — absent (not undefined) on legacy stamps so
    // pre-feature briefs round-trip byte-identical.
    ...(mode ? { mode } : {}),
    ...(experiment ? { experiment } : {}),
  };
}

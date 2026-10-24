/**
 * Industry-aware ANGLE vocabularies. Client-safe (pure data) sibling to
 * `industries.ts`.
 *
 * Why this exists: the global angle list in `label-taxonomy.ts` (`pain_relief,
 * convenience, price_value, status, health, time_saving, trust_safety`) is too
 * coarse to surface what differentiates winning ads in a given vertical — a
 * jewellery ad's real motivation (gifting, heirloom, craftsmanship) collapses
 * into `status`/`other`. So the LLM picks a high-resolution **industry-specific**
 * `angle` AND a stable global `angle_universal` (the two-layer design).
 *
 * Only ANGLES are industry-specific. Hooks and formats are genuinely universal
 * (problem_callout, social_proof, UGC, before/after work everywhere) and stay
 * global in `label-taxonomy.ts`.
 *
 * An unclassified brand (or low classifier confidence) falls back to the global
 * `ANGLES` list, so there is zero regression when `industry` is unknown.
 */

import {
  ANGLES,
  PERSONAS,
  type Angle,
  type Persona,
} from '@/services/ad-library/label-taxonomy';
import type { IndustryKey } from './industries';
import {
  ANGLE_LABELS,
  ANGLE_UNIVERSAL_BY_TOKEN,
  INDUSTRY_ANGLES,
  INDUSTRY_PERSONAS,
  PERSONA_LABELS,
  PERSONA_UNIVERSAL_BY_TOKEN,
} from './industry-vocabulary';

// The vocabulary tables live in ./industry-vocabulary.ts (pure data);
// re-exported so existing imports of the tables keep working.
export { INDUSTRY_ANGLES, INDUSTRY_PERSONAS };

/**
 * Angles relevant to EVERY vertical — always appended to an industry's
 * vocabulary so price/trust framing and a fallback bucket are never missing.
 * Reused from the global `ANGLES` so these few values stay comparable across
 * industries even on the high-resolution `angle` field.
 */
export const UNIVERSAL_CORE_ANGLES = ['price_value', 'trust_safety', 'other'] as const;

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * The allowed `angle` values for a brand in the given industry: its curated
 * vocabulary plus the universal core. Falls back to the global `ANGLES` list
 * when the industry is null/unknown (unclassified brand → zero regression).
 */
export function getAngleVocabulary(industryKey: string | null | undefined): string[] {
  if (!industryKey) return [...ANGLES];
  const industryAngles = INDUSTRY_ANGLES[industryKey as IndustryKey];
  if (!industryAngles) return [...ANGLES];
  return dedupe([...industryAngles, ...UNIVERSAL_CORE_ANGLES, 'other']);
}

/** Display label for any angle value (industry-specific or universal). */
export function getAngleLabel(value: string): string {
  return (
    ANGLE_LABELS[value] ??
    value
      .split('_')
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join(' ')
  );
}

/**
 * Every angle value that can appear in `ad_labels.angle` across all industries
 * plus the universal list. Backs `isKnownAngle`, which validates library
 * filter input without knowing the active competitor's industry at
 * request-schema parse time.
 */
const ALL_ANGLE_VALUE_SET = new Set<string>(
  dedupe([
    ...ANGLES,
    ...Object.values(INDUSTRY_ANGLES).flat(),
    ...UNIVERSAL_CORE_ANGLES,
  ])
);

/** Whether a string is a known angle value (any industry or universal). */
export function isKnownAngle(value: string): boolean {
  return ALL_ANGLE_VALUE_SET.has(value);
}

/* ── Persona vocabulary (mirrors the angle machinery above) ─────────────── */

/**
 * Personas relevant to EVERY vertical — always appended to an industry's
 * persona vocabulary so a broad-reach bucket and a fallback are never missing.
 * These are the two `PERSONAS` values that describe an audience with no vertical
 * specificity, so they stay comparable across industries even on the
 * high-resolution `persona` field.
 */
export const UNIVERSAL_CORE_PERSONAS = ['general_broad', 'other'] as const;

/**
 * The allowed `persona` values for a brand in the given industry: its curated
 * vocabulary plus the universal core. Falls back to the universal `PERSONAS`
 * list when the industry is null/unknown (unclassified brand → zero regression).
 */
export function getPersonaVocabulary(
  industryKey: string | null | undefined
): string[] {
  if (!industryKey) return [...PERSONAS];
  const industryPersonas = INDUSTRY_PERSONAS[industryKey as IndustryKey];
  if (!industryPersonas) return [...PERSONAS];
  return dedupe([...industryPersonas, ...UNIVERSAL_CORE_PERSONAS]);
}

/** Display label for any persona value (industry-specific or universal). */
export function getPersonaLabel(value: string): string {
  return (
    PERSONA_LABELS[value] ??
    value
      .split('_')
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join(' ')
  );
}

/**
 * Every persona value that can appear in `ad_labels.persona` across all
 * industries plus the universal list. Backs `isKnownPersona`, which validates
 * library filter input without knowing the active competitor's industry at
 * request-schema parse time.
 */
const ALL_PERSONA_VALUE_SET = new Set<string>(
  dedupe([
    ...PERSONAS,
    ...Object.values(INDUSTRY_PERSONAS).flat(),
    ...UNIVERSAL_CORE_PERSONAS,
  ])
);

/** Whether a string is a known persona value (any industry or universal). */
export function isKnownPersona(value: string): boolean {
  return ALL_PERSONA_VALUE_SET.has(value);
}

/* ── Reverse lookups: high-resolution token → stable global member ───────── */

/**
 * Roll a high-resolution industry `angle` token up to its global `ANGLES`
 * member. Completes this module's two-layer contract in the other direction:
 * `getAngleVocabulary` widens the vocabulary per industry, this narrows a token
 * back to the cross-industry-comparable value that `ad_labels.angle_universal`
 * and the creative-engine genome share.
 *
 * Returns `null` for an unrecognized token — the CALLER decides the floor, so a
 * lookup miss is never silently indistinguishable from a genuine `other`.
 */
export function universalAngleFor(value: string | null | undefined): Angle | null {
  const token = (value ?? '').trim().toLowerCase();
  if (token.length === 0) return null;
  return (ANGLE_UNIVERSAL_BY_TOKEN[token] as Angle | undefined) ?? null;
}

/** Persona twin of `universalAngleFor`. Returns `null` on an unknown token. */
export function universalPersonaFor(value: string | null | undefined): Persona | null {
  const token = (value ?? '').trim().toLowerCase();
  if (token.length === 0) return null;
  return (PERSONA_UNIVERSAL_BY_TOKEN[token] as Persona | undefined) ?? null;
}

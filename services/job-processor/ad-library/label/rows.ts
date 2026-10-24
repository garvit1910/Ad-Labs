import {
  LABEL_TAXONOMY_VERSION,
  type AdFingerprint,
} from '@/services/ad-library/label-taxonomy';
import type { ParsedLabelItem } from './parse';
import type { LabelRow } from './types';

/** Notes past this are trimmed to the last whole word (single choke point
 * for the OpenAI poster path and the Gemini video path). */
export const EXECUTION_NOTES_MAX_LENGTH = 320;
const EXECUTION_NOTES_MIN_LENGTH = 10;

/** Deterministic execution_notes normalization: whitespace-collapse, hard
 * cap, and a floor under which a fragment carries no staging signal. */
function normalizeExecutionNotes(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let notes = raw.replace(/\s+/g, ' ').trim();
  if (notes.length > EXECUTION_NOTES_MAX_LENGTH) {
    const cut = notes.slice(0, EXECUTION_NOTES_MAX_LENGTH);
    const lastSpace = cut.lastIndexOf(' ');
    notes = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return notes.length >= EXECUTION_NOTES_MIN_LENGTH ? notes : null;
}

/** Drops nullish fingerprint attributes; returns null when nothing remains. */
export function normalizeFingerprint(
  fingerprint: ParsedLabelItem['fingerprint']
): AdFingerprint | null {
  if (!fingerprint) return null;
  const entries = Object.entries(fingerprint)
    .map(([key, value]) =>
      key === 'execution_notes'
        ? ([key, normalizeExecutionNotes(value)] as const)
        : ([key, value] as const)
    )
    .filter(([, value]) => value !== null && value !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as AdFingerprint) : null;
}

export function toLabelRow(
  item: ParsedLabelItem,
  organizationId: string,
  model: string,
  nowIso: string,
  aspectRatio: string | null,
  hasVisualContext: boolean
): LabelRow {
  return {
    organization_id: organizationId,
    library_ad_id: item.library_ad_id,
    hook_archetype: item.hook_archetype,
    angle: item.angle,
    angle_universal: item.angle_universal,
    // persona/funnel_stage are text-derivable — mapped unconditionally like
    // angle (NOT gated on visual context, unlike the style/fingerprint path).
    persona: item.persona,
    persona_universal: item.persona_universal,
    funnel_stage: item.funnel_stage,
    format: item.format,
    // style/fingerprint are VISUAL judgments — deterministically null for ads
    // labelled without an image or video, whatever the model returned.
    style: hasVisualContext ? item.style ?? null : null,
    aspect_ratio: aspectRatio,
    fingerprint: hasVisualContext ? normalizeFingerprint(item.fingerprint) : null,
    // 'none' is stored as null so "has an offer" filters stay simple.
    offer_type: item.offer_type === 'none' ? null : item.offer_type,
    hook_text: item.hook_text,
    summary: item.summary,
    confidence: item.confidence,
    model,
    labeled_at: nowIso,
    // Stamp the taxonomy version so the relabel script and sibling-copy guard
    // can tell v2-labelled rows from older ones. Safe on the upsert path here:
    // relabel deletes first and already-labeled ads are skipped, so this is
    // effectively an insert.
    tags: { taxonomyVersion: LABEL_TAXONOMY_VERSION },
  };
}

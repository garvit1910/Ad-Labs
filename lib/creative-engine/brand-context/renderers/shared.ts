/**
 * Shared renderer plumbing — version guard, per-ratio negative-space map,
 * and content-narrowing helpers.
 *
 * Renderers are pure: no IO, no clock, no randomness, no LLM. Each reads ONE
 * compiled pack; all ordering comes from the compiler's slot sort. Template
 * text lives inside the renderer version contract — editing any template
 * string requires bumping that kind in RENDERER_VERSIONS (new fingerprints)
 * and re-recording the inline snapshots deliberately.
 */
import {
  BrandContextError,
  RENDERER_VERSIONS,
  type BrandContextPack,
  type SlotEntry,
} from '../types';

export type RendererKind = keyof typeof RENDERER_VERSIONS;

/**
 * A pack fingerprint attests the renderer versions its bytes were minted
 * under; rendering across versions would break the fingerprint → render
 * claim. Per-kind check only — an image-template bump must not brick judge
 * renders of old packs.
 */
export function assertRendererVersion(
  pack: BrandContextPack,
  kind: RendererKind,
): void {
  const packVersion = pack.meta.rendererVersions[kind];
  if (packVersion !== RENDERER_VERSIONS[kind]) {
    throw new BrandContextError(
      'RENDERER_VERSION_MISMATCH',
      `Pack was compiled for ${kind} renderer v${packVersion}; this code renders v${RENDERER_VERSIONS[kind]}`,
      'Recompile the pack against the current store — the fingerprint attests renderer templates, so packs are never rendered across versions',
      409,
    );
  }
}

/**
 * Ratio keys mirror generation/types.ts AspectRatio (not imported —
 * brand-context stays dependency-light). Image renderer v2 deleted the
 * negative-space machinery (no compositor bands exist anymore); only the
 * known-ratio guard and the 9:16 platform-safe-zone note remain. A new ratio
 * there needs an entry here plus an image + judge version bump.
 */
export const KNOWN_ASPECT_RATIOS = ['1:1', '4:5', '9:16', '16:9'] as const;

export function assertKnownAspectRatio(aspectRatio: string): void {
  if (!(KNOWN_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    throw new BrandContextError(
      'UNSUPPORTED_ASPECT_RATIO',
      `Unknown aspect ratio "${aspectRatio}"`,
      'Use one of 1:1, 4:5, 9:16, 16:9 (generation AspectRatio union), or add support for the new ratio and bump the image + judge RENDERER_VERSIONS',
      422,
    );
  }
}

/**
 * 9:16 placements render under platform chrome (story/reels UI covers the top
 * and bottom bands) — a real platform constraint, not an overlay reservation.
 */
export const STORY_SAFE_ZONE_9_16 =
  'Keep the hero product and all critical subject matter inside the middle 60% of the frame; the platform UI covers the top and bottom bands of 9:16 placements.';

/** Min across image providers (OpenAI 4, Google 10). Defensive slice only. */
export const IMAGE_REFERENCE_ASSET_CAP = 4;

/**
 * Collapses every internal whitespace run (newlines included) to ONE space
 * and trims the ends.
 *
 * Row content is ingested verbatim from brand_facts, and a large share of it
 * is customer-review-derived (VOC statements, persona verbatims). Embedding a
 * multi-line string in a prompt that uses `## ` section headers lets that text
 * forge a section or inject its own directives, so every rendered content
 * string passes through here. Structural template text is unaffected (it has
 * no internal newlines); the spec echo (angle in particular — the attribution
 * key) is deliberately NOT collapsed.
 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function malformedRow(
  entry: SlotEntry,
  slot: string,
  detail: string,
): never {
  // 500, not 4xx — ingest is the only content writer, so unreadable content
  // is a bug with nothing for the caller to remediate.
  throw new BrandContextError(
    'MALFORMED_ROW',
    `Slot "${slot}" entry "${entry.id}@v${entry.version}" ${detail}`,
    'Ingest controls row content shapes — this is a bug; re-run ingest and inspect the offending brand_context_rows version',
    500,
  );
}

export function requireString(
  entry: SlotEntry,
  key: string,
  slot: string,
): string {
  const value = entry.content[key];
  if (typeof value !== 'string' || value.length === 0) {
    malformedRow(entry, slot, `is missing required content field "${key}"`);
  }
  return value;
}

export function optionalString(
  entry: SlotEntry,
  key: string,
): string | undefined {
  const value = entry.content[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Persona list fields hold strings (verbatims) or `{fact_id, note}` citation
 * objects (pains/desires/objections — the personas/prompt.ts card shape).
 * Absent/non-array → []; a present item that is neither shape is the same
 * ingest bug as a missing statement.
 */
export function noteList(
  entry: SlotEntry,
  key: string,
  slot: string,
): string[] {
  const value = entry.content[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return item;
    if (
      item !== null &&
      typeof item === 'object' &&
      typeof (item as { note?: unknown }).note === 'string'
    ) {
      return (item as { note: string }).note;
    }
    return malformedRow(
      entry,
      slot,
      `has an unreadable "${key}" list item (expected a string or {note})`,
    );
  });
}

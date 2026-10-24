/**
 * Content hashing for the brand context layer.
 *
 * Full 64-hex sha256 (unlike the 32-char slices in the synthesis packs —
 * this one is a primary key). The pack fingerprint is always computed from
 * the in-memory pack at compile time, never re-derived from a jsonb read
 * (Postgres jsonb loses key order; canonicalization makes that harmless,
 * but the compile-time hash is the source of truth).
 */
import { createHash } from 'crypto';
import { canonicalJson } from './canonical-json';
import type { BrandContextPack, BrandContextRow, TagFilters } from './types';
import { TAG_FILTER_AXES } from './types';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function fingerprintPack(pack: BrandContextPack): string {
  return sha256Hex(canonicalJson(pack));
}

/**
 * ONE canonical representation per tag set: unknown keys are dropped, empty/
 * absent axes collapse (`{}`, `{channels: []}`, and an omitted axis hash
 * identically), and each surviving axis is deduped and code-unit sorted —
 * membership is what a tag axis means, so `['b','a','b']` and `['a','b']` are
 * the same set and must hash the same. (Ingest already emits sorted unique
 * audiences/stages; this makes the canonical claim true for every caller,
 * including hand-authored rows.)
 */
export function normalizeTagFilters(tagFilters: TagFilters): TagFilters {
  const normalized: TagFilters = {};
  for (const axis of TAG_FILTER_AXES) {
    const list = tagFilters[axis];
    if (Array.isArray(list) && list.length > 0) {
      // Default Array#sort is code-unit ordering — the same comparison the
      // canonical-JSON key sort and the compiler's rowId tie-break use.
      normalized[axis] = [...new Set(list)].sort();
    }
  }
  return normalized;
}

/**
 * The ingest change detector. `sourceRef` and `rowId` deliberately do NOT
 * participate: a re-promoted upstream fact with a new uuid but identical
 * content must not mint a new version.
 */
export function rowContentHash(
  row: Pick<BrandContextRow, 'content' | 'priority' | 'tagFilters'>,
): string {
  return sha256Hex(
    canonicalJson({
      content: row.content,
      priority: row.priority,
      tagFilters: normalizeTagFilters(row.tagFilters),
    }),
  );
}

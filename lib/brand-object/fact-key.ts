/**
 * Stable fact identity across theme-cluster rebuilds. brand_presence_themes
 * ids change on every cluster run, but a brand fact must keep its identity
 * so human confirmation (confidence 1.0) has something durable to attach to.
 * Identity is carried by embedding-space position: a candidate matches an
 * existing fact when its centroid cosine against the existing fact's
 * centroid clears the threshold; the normalized label slug is the fallback
 * when vectors are missing (small-corpus LLM-grouped themes) or ambiguous.
 * PURE — callers supply centroids (mean of member phrase embeddings).
 */
import { cosineSimilarity } from '@/lib/brand-identity/clustering';

/**
 * Normalized slug of a theme label / fact statement head. `maxLength`
 * defaults to the 60-char head every existing fact key was minted with —
 * change the default and every slug-keyed identity forks. Pass a larger
 * bound only to DETECT truncation (`review/state-fact.ts`).
 */
export function slugifyLabel(label: string, maxLength = 60): string {
  return (
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength) || 'unlabeled'
  );
}

export interface KeyCandidate {
  /** Free-text theme label (or statement head for non-VOC facts). */
  label: string;
  /** Mean member-phrase embedding; undefined when unavailable. */
  centroid?: number[];
}

export interface ExistingKey {
  factKey: string;
  centroid?: number[];
}

export interface AssignedKey {
  /** Existing factKey when matched, else a fresh slug-based key. */
  factKey: string;
  matchedExisting: boolean;
}

/**
 * Assign fact keys for a batch of candidates against the existing live facts
 * of ONE (brand, section). Batch-consistent: each existing key is claimed by
 * at most one candidate (best cosine wins), and fresh keys are de-duplicated
 * within the batch with a numeric suffix.
 */
export function assignFactKeys(
  candidates: KeyCandidate[],
  existing: ExistingKey[],
  opts: { matchCosine: number },
): AssignedKey[] {
  const results: Array<AssignedKey | null> = candidates.map(() => null);
  const claimed = new Set<string>();

  // Pass 1 — cosine matches, strongest pair first so a rebuilt cluster that
  // split in two can't both grab the same identity.
  const pairs: Array<{ ci: number; key: string; sim: number }> = [];
  candidates.forEach((candidate, ci) => {
    if (!candidate.centroid) return;
    for (const ex of existing) {
      if (!ex.centroid) continue;
      const sim = cosineSimilarity(candidate.centroid, ex.centroid);
      if (sim >= opts.matchCosine) pairs.push({ ci, key: ex.factKey, sim });
    }
  });
  pairs.sort((a, b) => b.sim - a.sim);
  for (const pair of pairs) {
    if (results[pair.ci] || claimed.has(pair.key)) continue;
    results[pair.ci] = { factKey: pair.key, matchedExisting: true };
    claimed.add(pair.key);
  }

  // Pass 2 — exact slug fallback, ONLY when a vector is missing on either
  // side. When both sides have centroids, pass 1 already ruled on the match
  // and an identical label must not override the embedding-space verdict.
  const existingByKey = new Map(existing.map((ex) => [ex.factKey, ex]));
  const existingKeys = new Set(existing.map((ex) => ex.factKey));
  candidates.forEach((candidate, ci) => {
    if (results[ci]) return;
    const slug = slugifyLabel(candidate.label);
    const match = existingByKey.get(slug);
    if (!match || claimed.has(slug)) return;
    if (candidate.centroid && match.centroid) return;
    results[ci] = { factKey: slug, matchedExisting: true };
    claimed.add(slug);
  });

  // Pass 3 — fresh keys, unique within batch AND against unmatched existing
  // keys (a slug collision with a ruled-out existing fact must not silently
  // attach to it).
  const taken = new Set<string>([...existingKeys, ...claimed]);
  candidates.forEach((candidate, ci) => {
    if (results[ci]) return;
    const base = slugifyLabel(candidate.label);
    let key = base;
    let n = 2;
    while (taken.has(key)) key = `${base}-${n++}`;
    taken.add(key);
    results[ci] = { factKey: key, matchedExisting: false };
  });

  return results as AssignedKey[];
}

/** Mean vector helper for callers computing fact/theme centroids. */
export function meanVector(vectors: number[][]): number[] | undefined {
  const usable = vectors.filter((v) => v.length > 0);
  if (usable.length === 0) return undefined;
  const dims = usable[0].length;
  const out = new Array<number>(dims).fill(0);
  for (const vec of usable) {
    if (vec.length !== dims) continue;
    for (let i = 0; i < dims; i++) out[i] += vec[i];
  }
  for (let i = 0; i < dims; i++) out[i] /= usable.length;
  return out;
}

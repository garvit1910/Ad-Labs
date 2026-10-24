/**
 * Read-time cosine clustering of competitor-ad copy embeddings — the
 * replication signal. Grouping and dedup are one operation: near-identical
 * copy (high cosine) collapses as a re-run, moderately similar copy counts as
 * a variation, and the number of distinct variations left in a cluster is the
 * replication score (our proxy for "they're scaling a winner"). More robust
 * than label-based grouping because it does not depend on label quality.
 *
 * Clustering is scoped to a single competitor — replication is one brand
 * scaling one message, so vectors are never compared across competitors.
 *
 * Thresholds are the calibration surface. Defaults are rough starting points;
 * anchor them against the real pairwise-cosine distribution
 * (scripts/ad-library/cosine-distribution.ts) before locking. Because
 * clustering runs at read time, recalibration is just editing these constants.
 *
 * Brand-presence theme clustering reuses the UPGMA machinery via
 * clusterFamiliesAdaptive (adaptive target-count stop rule); clusterByCosine
 * and its constants stay ad-library-only.
 */

/** cosine >= this collapses two ads as the same re-run (a duplicate). */
export const DUPLICATE_COSINE = 0.95;
/**
 * Average cosine >= this joins two clusters into one message family (a
 * variation). Family grouping is average-linkage agglomerative (UPGMA): a
 * cluster only absorbs another when their *mean* pairwise similarity clears the
 * bar, which avoids the single-linkage "chaining" where A~B~C transitively
 * pulls in A and C that are not themselves similar.
 */
export const VARIATION_COSINE = 0.75;

export interface ClusterInput {
  id: string;
  competitorId: string;
  /**
   * The embedding model that produced `vector`. Clustering only ever compares
   * vectors from the caller's current model — see `clusterByCosine`.
   */
  embeddingModel: string;
  vector: number[];
}

/** Optional threshold overrides — defaults are the ad-clustering constants. */
export interface ClusterOptions {
  variationCosine?: number;
  duplicateCosine?: number;
}

/** State the UPGMA merge loop exposes to the stop rule before each merge. */
export interface MergeStepContext {
  activeClusterCount: number;
  bestMeanSimilarity: number;
}

/** Adaptive stopping rule for clusterFamiliesAdaptive (brand-presence VOC). */
export interface AdaptiveClusterOptions {
  /** Stop merging once activeClusterCount <= this, unless the best pair is
   * still at/above softCosine (near-duplicate clusters always collapse). */
  targetClusterCount: number;
  /** Keep merging past targetClusterCount while best mean sim >= this. */
  softCosine: number;
  /** Never merge two clusters whose mean sim is below this. */
  mergeFloor: number;
}

export interface ClusterAssignment {
  /** Stable id shared by every ad in the same message family. */
  clusterId: string;
  /** Distinct variations in the family after collapsing exact re-runs. */
  replicationScore: number;
}

/**
 * Cosine similarity. OpenAI embeddings are unit-normalized, so this reduces to
 * a dot product in practice; we still divide by the norms so the function is
 * correct for arbitrary (e.g. synthetic test) vectors. Mismatched-length or
 * zero vectors are treated as fully dissimilar.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Union-find over array indices with path halving. */
class DisjointSet {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) {
      this.parent[root] = this.parent[this.parent[root]];
      root = this.parent[root];
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function assignWithinCompetitor(
  group: ClusterInput[],
  out: Map<string, ClusterAssignment>,
  opts: Required<ClusterOptions>
): void {
  const n = group.length;
  if (n === 0) return;
  if (n === 1) {
    out.set(group[0].id, { clusterId: group[0].id, replicationScore: 1 });
    return;
  }

  // Full pairwise similarity matrix (N small per competitor) — feeds both the
  // average-linkage family pass and the within-family duplicate collapse.
  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(group[i].vector, group[j].vector);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  const members = averageLinkageFamilies(
    n,
    sim,
    (ctx) => ctx.bestMeanSimilarity >= opts.variationCosine,
  );

  for (const family of members) {
    // replicationScore = distinct duplicates within the family. Re-runs
    // (pairwise cosine >= duplicateCosine) collapse to one bucket; the bucket
    // count is the number of distinct variations the competitor is running.
    const dup = new DisjointSet(family.length);
    for (let i = 0; i < family.length; i++) {
      for (let j = i + 1; j < family.length; j++) {
        if (sim[family[i]][family[j]] >= opts.duplicateCosine) dup.union(i, j);
      }
    }
    const buckets = new Set<number>();
    for (let i = 0; i < family.length; i++) buckets.add(dup.find(i));

    // Stable cluster id = smallest ad id in the family (order-independent).
    let clusterId = group[family[0]].id;
    for (const m of family) {
      if (group[m].id < clusterId) clusterId = group[m].id;
    }
    const assignment: ClusterAssignment = {
      clusterId,
      replicationScore: buckets.size,
    };
    for (const m of family) out.set(group[m].id, assignment);
  }
}

/**
 * Average-linkage (UPGMA) agglomerative clustering over indices [0,n). Starts
 * with singletons and repeatedly merges the two clusters with the highest
 * *mean* pairwise similarity while the caller's stop rule allows the merge
 * (the classic form is `best >= variationCosine`). Returns the final clusters
 * as arrays of member indices.
 */
function averageLinkageFamilies(
  n: number,
  sim: number[][],
  shouldMerge: (_ctx: MergeStepContext) => boolean
): number[][] {
  const members = new Map<number, number[]>();
  const active: number[] = [];
  for (let i = 0; i < n; i++) {
    members.set(i, [i]);
    active.push(i);
  }
  // crossSum[a][b] = sum of pairwise sims between every member of a and b.
  // Average similarity = crossSum / (|a| * |b|). UPGMA update on merge:
  // crossSum[ab][c] = crossSum[a][c] + crossSum[b][c].
  const crossSum = new Map<number, Map<number, number>>();
  for (const a of active) crossSum.set(a, new Map());
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      crossSum.get(a)!.set(b, sim[a][b]);
      crossSum.get(b)!.set(a, sim[a][b]);
    }
  }

  while (active.length > 1) {
    let best = -Infinity;
    let bestA = -1;
    let bestB = -1;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        const avg =
          crossSum.get(a)!.get(b)! /
          (members.get(a)!.length * members.get(b)!.length);
        if (avg > best) {
          best = avg;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (
      !shouldMerge({
        activeClusterCount: active.length,
        bestMeanSimilarity: best,
      })
    ) {
      break;
    }

    // Merge bestB into bestA.
    members.set(bestA, members.get(bestA)!.concat(members.get(bestB)!));
    for (const c of active) {
      if (c === bestA || c === bestB) continue;
      const merged =
        crossSum.get(bestA)!.get(c)! + crossSum.get(bestB)!.get(c)!;
      crossSum.get(bestA)!.set(c, merged);
      crossSum.get(c)!.set(bestA, merged);
      crossSum.get(c)!.delete(bestB);
    }
    members.delete(bestB);
    crossSum.delete(bestB);
    active.splice(active.indexOf(bestB), 1);
  }

  return active.map((id) => members.get(id)!);
}

/**
 * Average-linkage clustering with an adaptive stopping rule, for short-text
 * corpora (brand-presence VOC paraphrases): keep merging while the cluster
 * count is above targetClusterCount OR the best pair is still near-duplicate
 * (>= softCosine), but never merge below mergeFloor. Small corpora naturally
 * yield few clusters; large corpora converge toward the target instead of
 * fragmenting. Returns families of input indices. Does NOT alter
 * clusterByCosine / ad-library behavior.
 */
export function clusterFamiliesAdaptive(
  vectors: number[][],
  opts: AdaptiveClusterOptions
): number[][] {
  const n = vectors.length;
  if (n === 0) return [];
  if (n === 1) return [[0]];

  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(vectors[i], vectors[j]);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  return averageLinkageFamilies(
    n,
    sim,
    (ctx) =>
      ctx.bestMeanSimilarity >= opts.mergeFloor &&
      (ctx.activeClusterCount > opts.targetClusterCount ||
        ctx.bestMeanSimilarity >= opts.softCosine)
  );
}

/**
 * Clusters ads within each competitor by cosine similarity and returns a per-ad
 * cluster id + replication score. Ads are keyed by their `id`; an ad alone in
 * its competitor maps to a singleton cluster with replicationScore 1.
 *
 * Same-model invariant: only vectors whose `embeddingModel` equals `currentModel`
 * are clustered. A bump of the embedding model without a full re-index leaves
 * stale vectors in `ad_embeddings`; even at equal dimensionality their
 * coordinates live in a different space, so comparing them against current-model
 * vectors would silently corrupt the replication signal. Stale-model vectors are
 * therefore dropped (their ads read as "not yet scored" until re-embedded),
 * never mixed into a cluster.
 */
export function clusterByCosine(
  items: ClusterInput[],
  currentModel: string,
  options: ClusterOptions = {}
): Map<string, ClusterAssignment> {
  const opts: Required<ClusterOptions> = {
    variationCosine: options.variationCosine ?? VARIATION_COSINE,
    duplicateCosine: options.duplicateCosine ?? DUPLICATE_COSINE,
  };
  const byCompetitor = new Map<string, ClusterInput[]>();
  for (const item of items) {
    if (item.embeddingModel !== currentModel) continue;
    const arr = byCompetitor.get(item.competitorId);
    if (arr) arr.push(item);
    else byCompetitor.set(item.competitorId, [item]);
  }

  const out = new Map<string, ClusterAssignment>();
  for (const group of byCompetitor.values()) {
    assignWithinCompetitor(group, out, opts);
  }
  return out;
}

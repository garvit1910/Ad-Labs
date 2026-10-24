/**
 * Pure theme-building math over clustered phrase embeddings (no DB, no LLM).
 * The cluster processor partitions embedded phrases by (kind × scope) and,
 * per partition, either groups them with one small-corpus LLM call
 * (theme-grouping.ts) or runs clusterPartitionAdaptive here — adaptive-cut
 * UPGMA via the SHARED clustering module (lib/brand-identity/clustering.ts
 * clusterFamiliesAdaptive, reused per the "don't write a novel clustering
 * algorithm" rule) targeting ~sqrt(N/2) angles. Leftover singletons attach to
 * the nearest angle centroid (>= attachFloor) or pool into the partition
 * catch-all — they never become standalone 1-mention themes.
 * buildDraftsFromGroupings turns groupings into theme drafts: centroid
 * representatives, frequency / mention-count / sentiment math.
 */
import {
  clusterFamiliesAdaptive,
  cosineSimilarity,
} from '@/lib/brand-identity/clustering';
import type { PhraseScope, ThemeKind } from './types';

export interface PhraseForClustering {
  id: string;
  mentionId: string;
  kind: ThemeKind;
  scope: PhraseScope;
  phrase: string;
  paraphrase: string | null;
  sentiment: number | null;
  vector: number[];
}

export interface ThemeDraft {
  kind: ThemeKind;
  scope: PhraseScope;
  isCatchall: boolean;
  /** Member phrase ids (drives phrases.theme_id repointing). */
  phraseIds: string[];
  /** Nearest-to-centroid member ids, for verbatim representative display. */
  representativePhraseIds: string[];
  /** Representative paraphrases — the LLM labeling input. */
  representativeTexts: string[];
  /** Pre-assigned label/summary (small-corpus LLM grouping path);
   * null → the labelThemes batch names this draft. */
  label: string | null;
  summary: string | null;
  frequency: number;
  mentionCount: number;
  avgSentiment: number | null;
}

/** One angle within a partition, optionally pre-labeled (LLM grouping). */
export interface PhraseGroup {
  members: PhraseForClustering[];
  label: string | null;
  summary: string | null;
}

/** A (kind × scope) partition's grouping result, either path. */
export interface PartitionGrouping {
  kind: ThemeKind;
  scope: PhraseScope;
  groups: PhraseGroup[];
  /** Leftovers pooled into the partition catch-all (may be empty). */
  catchallMembers: PhraseForClustering[];
}

export interface ClusterPartitionConfig {
  targetAngles: { min: number; max: number };
  softCosine: number;
  mergeFloor: number;
  attachFloor: number;
  /** Families below this size are leftovers for the attach/catch-all pass. */
  minClusterSize: number;
}

/** Adaptive angle target: ~sqrt(N/2) clamped to the configured range, so a
 * small corpus yields few angles and a large one converges instead of
 * fragmenting. */
export function computeTargetClusterCount(
  n: number,
  range: { min: number; max: number },
): number {
  return Math.min(range.max, Math.max(range.min, Math.round(Math.sqrt(n / 2))));
}

/**
 * Embedding path for one (kind × scope) partition: adaptive-cut UPGMA over
 * the phrase vectors, then leftover singletons attach to the nearest kept
 * angle (pre-attach centroids, so attach order can't matter) at/above
 * attachFloor, else pool into the catch-all. Pure and deterministic.
 */
export function clusterPartitionAdaptive(
  phrases: PhraseForClustering[],
  config: ClusterPartitionConfig,
): PartitionGrouping {
  const base: PartitionGrouping = {
    kind: phrases[0].kind,
    scope: phrases[0].scope,
    groups: [],
    catchallMembers: [],
  };
  const families = clusterFamiliesAdaptive(
    phrases.map((phrase) => phrase.vector),
    {
      targetClusterCount: computeTargetClusterCount(
        phrases.length,
        config.targetAngles,
      ),
      softCosine: config.softCosine,
      mergeFloor: config.mergeFloor,
    },
  );

  const kept: PhraseForClustering[][] = [];
  const leftovers: PhraseForClustering[] = [];
  for (const family of families) {
    const members = family.map((index) => phrases[index]);
    if (members.length >= config.minClusterSize) kept.push(members);
    else leftovers.push(...members);
  }

  // Attach decisions use the PRE-attach centroids of the kept angles.
  const centroids = kept.map((members) =>
    meanVector(members.map((member) => member.vector)),
  );
  for (const phrase of leftovers) {
    let bestIndex = -1;
    let bestSim = -Infinity;
    for (let i = 0; i < centroids.length; i++) {
      const sim = cosineSimilarity(phrase.vector, centroids[i]);
      if (sim > bestSim) {
        bestSim = sim;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0 && bestSim >= config.attachFloor) {
      kept[bestIndex].push(phrase);
    } else {
      base.catchallMembers.push(phrase);
    }
  }

  base.groups = kept.map((members) => ({
    members,
    label: null,
    summary: null,
  }));
  return base;
}

/**
 * Turns partition groupings into theme drafts — one per group plus at most
 * one catch-all per partition. Deterministic order (biggest first within
 * kind/scope); every input phrase lands in exactly one draft by construction
 * (groups and catchallMembers are disjoint and exhaustive per partition).
 */
export function buildDraftsFromGroupings(
  groupings: PartitionGrouping[],
  config: { representativeCount: number },
): ThemeDraft[] {
  const themes: ThemeDraft[] = [];
  for (const grouping of groupings) {
    for (const group of grouping.groups) {
      if (group.members.length === 0) continue;
      const draft = draftFrom(group.members, config, false);
      draft.label = group.label;
      draft.summary = group.summary;
      themes.push(draft);
    }
    if (grouping.catchallMembers.length > 0) {
      themes.push(draftFrom(grouping.catchallMembers, config, true));
    }
  }
  themes.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.scope.localeCompare(b.scope) ||
      b.frequency - a.frequency,
  );
  return themes;
}

/** Derives a draft (centroid representatives, counts, sentiment) from a
 * member list. Also used by the theme-merge pass to re-derive merged drafts. */
export function draftFrom(
  members: PhraseForClustering[],
  config: { representativeCount: number },
  isCatchall: boolean,
): ThemeDraft {
  const centroid = meanVector(members.map((member) => member.vector));
  const ranked = [...members].sort(
    (a, b) =>
      cosineSimilarity(b.vector, centroid) -
      cosineSimilarity(a.vector, centroid),
  );
  const representatives = ranked.slice(0, config.representativeCount);
  const sentiments = members
    .map((member) => member.sentiment)
    .filter((value): value is number => value != null);
  return {
    kind: members[0].kind,
    scope: members[0].scope,
    isCatchall,
    phraseIds: members.map((member) => member.id),
    representativePhraseIds: representatives.map((member) => member.id),
    representativeTexts: representatives.map(
      (member) => member.paraphrase ?? member.phrase,
    ),
    label: null,
    summary: null,
    frequency: members.length,
    mentionCount: new Set(members.map((member) => member.mentionId)).size,
    avgSentiment:
      sentiments.length === 0
        ? null
        : sentiments.reduce((sum, value) => sum + value, 0) / sentiments.length,
  };
}

function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const out = new Array(vectors[0].length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < out.length; i++) out[i] += vector[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length;
  return out;
}

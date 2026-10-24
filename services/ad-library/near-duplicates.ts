/**
 * Cheap near-duplicate detection over creative bodies. Advertisers scaling a
 * winning concept launch several lightly edited variants in a short window;
 * grouping by normalized text catches that without embeddings or pg_trgm.
 */

export function normalizeCreativeBody(body: string): string {
  return body
    .toLowerCase()
    .normalize('NFKD')
    // Strip emoji and symbols, keep letters/digits across scripts.
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NearDuplicateInput {
  id: string;
  creativeBodies: string[];
  firstSeenAt: string;
}

export interface NearDuplicateCluster {
  /** Normalized body shared by every ad in the cluster. */
  normalizedBody: string;
  adIds: string[];
}

/**
 * Groups ads whose primary creative body normalizes to the same text.
 * Returns only clusters with at least `minSize` members (default 2).
 */
export function groupNearDuplicates(
  ads: NearDuplicateInput[],
  minSize = 2
): NearDuplicateCluster[] {
  const groups = new Map<string, string[]>();
  for (const ad of ads) {
    const primaryBody = ad.creativeBodies[0];
    if (!primaryBody) continue;
    const normalized = normalizeCreativeBody(primaryBody);
    if (!normalized) continue;
    const existing = groups.get(normalized);
    if (existing) {
      existing.push(ad.id);
    } else {
      groups.set(normalized, [ad.id]);
    }
  }

  const clusters: NearDuplicateCluster[] = [];
  for (const [normalizedBody, adIds] of groups) {
    if (adIds.length >= minSize) {
      clusters.push({ normalizedBody, adIds });
    }
  }
  return clusters.sort((a, b) => b.adIds.length - a.adIds.length);
}

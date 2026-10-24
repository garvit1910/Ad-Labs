/**
 * Retrieval ranking — PURE. Filter ∩ exact cosine top-k over a brand's chunk
 * set (per-brand N is small; no ANN by design). score = cosine ×
 * (confidenceFloor + confidenceWeight × confidence): confirmed facts win
 * ties without burying fresh candidates. Compliance facts are appended by
 * the service AFTER ranking and never count against k.
 */
import { cosineSimilarity } from '@/lib/brand-identity/clustering';
import { BRAND_OBJECT_CONFIG } from '../config';

export interface ChunkForRank {
  factId: string;
  section: string;
  personaKey: string | null;
  awarenessStage: string | null;
  vector: number[];
}

export interface RankFilters {
  sections?: readonly string[];
  personaKey?: string;
  awarenessStage?: string;
}

export interface RankedChunk {
  factId: string;
  score: number;
  cosine: number;
}

export function rankChunks(
  chunks: ChunkForRank[],
  queryVector: number[],
  confidenceByFactId: Map<string, number>,
  filters: RankFilters,
  k: number,
): RankedChunk[] {
  const cfg = BRAND_OBJECT_CONFIG.retrieval;
  const cap = Math.max(1, Math.min(k, cfg.maxK));
  const ranked: RankedChunk[] = [];
  for (const chunk of chunks) {
    if (filters.sections && !filters.sections.includes(chunk.section)) {
      continue;
    }
    // Persona/stage filters use null-or-match semantics: persona-neutral
    // chunks stay retrievable for every persona.
    if (
      filters.personaKey &&
      chunk.personaKey !== null &&
      chunk.personaKey !== filters.personaKey
    ) {
      continue;
    }
    if (
      filters.awarenessStage &&
      chunk.awarenessStage !== null &&
      chunk.awarenessStage !== filters.awarenessStage
    ) {
      continue;
    }
    const cosine = cosineSimilarity(chunk.vector, queryVector);
    const confidence = confidenceByFactId.get(chunk.factId) ?? 0.5;
    ranked.push({
      factId: chunk.factId,
      cosine,
      score: cosine * (cfg.confidenceFloor + cfg.confidenceWeight * confidence),
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  // One chunk per fact in the slice (a fact could gain multi-chunk support
  // later; the door returns facts, not raw chunks).
  const seen = new Set<string>();
  const deduped: RankedChunk[] = [];
  for (const item of ranked) {
    if (seen.has(item.factId)) continue;
    seen.add(item.factId);
    deduped.push(item);
    if (deduped.length >= cap) break;
  }
  return deduped;
}

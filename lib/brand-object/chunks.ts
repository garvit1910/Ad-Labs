/**
 * Fact → retrieval chunk builder — PURE. One chunk per live fact: readable
 * statement + best verbatim + a deterministic metrics line, embedded by the
 * chunks processor. content_hash makes re-embedding idempotent (same content
 * ⇒ same hash ⇒ skip); any content change produces a new hash and the stale
 * chunk row is deleted (chunks are DERIVED).
 */
import { createHash } from 'node:crypto';
import type { EvidenceRef, FactMetrics } from './types';

export interface FactForChunk {
  id: string;
  section: string;
  factKey: string;
  statement: string;
  details: Record<string, unknown>;
  source: string;
  evidence: EvidenceRef[];
  metrics: FactMetrics;
}

export interface BuiltChunk {
  factId: string;
  content: string;
  section: string;
  personaKey: string | null;
  awarenessStage: string | null;
  sourceType: string;
  metadata: Record<string, unknown>;
  contentHash: string;
}

export function chunkContentHash(content: string): string {
  return createHash('sha256')
    .update(content.toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');
}

export function buildFactChunk(fact: FactForChunk): BuiltChunk {
  const lines: string[] = [`[${fact.section}] ${fact.statement}`];

  const verbatim = fact.evidence.find((ref) => ref.quote)?.quote;
  if (verbatim) lines.push(`Customer verbatim: "${verbatim}"`);

  const metricBits: string[] = [];
  if (fact.metrics.frequency != null) {
    metricBits.push(`${fact.metrics.frequency} mentions`);
  }
  if (fact.metrics.perPlatform) {
    const platforms = Object.entries(fact.metrics.perPlatform)
      .sort((a, b) => b[1] - a[1])
      .map(([platform, count]) => `${platform}: ${count}`)
      .join(', ');
    if (platforms) metricBits.push(platforms);
  }
  if (fact.metrics.winnerCount != null) {
    metricBits.push(`${fact.metrics.winnerCount} winning ads`);
  }
  if (metricBits.length > 0) lines.push(`Signal: ${metricBits.join(' — ')}`);

  const content = lines.join('\n');
  const details = fact.details as {
    awarenessStage?: unknown;
  };
  return {
    factId: fact.id,
    content,
    section: fact.section,
    // Persona facts scope their own chunk; pains referenced BY a persona
    // stay persona-neutral (retrieval matches persona_key OR NULL).
    personaKey: fact.section === 'persona' ? fact.factKey : null,
    awarenessStage:
      typeof details.awarenessStage === 'string'
        ? details.awarenessStage
        : null,
    sourceType: fact.source,
    metadata: { factKey: fact.factKey },
    contentHash: chunkContentHash(content),
  };
}

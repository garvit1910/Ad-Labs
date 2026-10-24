/**
 * retrieveBrandSlice — THE ONLY interface downstream consumers (strategy
 * generation, the brand_intel MCP op, future creative generation) may use to
 * read the Brand Object. Never returns the whole object: `query` is
 * required, results are SQL-filtered ∩ exact-cosine top-k, and live
 * compliance facts are ALWAYS appended (never counted against k). Callers
 * pass a service-role client and MUST have authorized the org/profile
 * upstream (routes use the loadProfileForOrg pattern).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EMBEDDING_MODEL,
  embedTexts,
  parseVectorLiteral,
} from '@/services/ad-library/embeddings';
import { BRAND_OBJECT_CONFIG } from '../config';
import type {
  AwarenessStage,
  BrandSection,
  EvidenceRef,
  FactMetrics,
  FactStatus,
} from '../types';
import { rankChunks, type ChunkForRank } from './rank';

export interface BrandSliceRequest {
  organizationId: string;
  brandProfileId: string;
  /** Omitted = all non-compliance sections. */
  sections?: BrandSection[];
  personaKey?: string;
  awarenessStage?: AwarenessStage;
  /** Required — the door never dumps the whole object. */
  query: string;
  k?: number;
}

export interface RetrievedFact {
  factId: string;
  factKey: string;
  section: BrandSection;
  statement: string;
  details: Record<string, unknown>;
  bestVerbatim?: string;
  confidence: number;
  status: Exclude<FactStatus, 'rejected'>;
  metrics: FactMetrics;
  evidence: EvidenceRef[];
  score: number;
}

export interface BrandSlice {
  facts: RetrievedFact[];
  /** Always appended, deduped against facts, never counted against k. */
  complianceFacts: RetrievedFact[];
  provenanceFactIds: string[];
  meta: { retrievedAt: string };
}

interface LiveFactRow {
  id: string;
  fact_key: string;
  section: string;
  statement: string;
  details: Record<string, unknown>;
  confidence: number;
  status: string;
  metrics: FactMetrics;
  evidence: EvidenceRef[];
}

export async function retrieveBrandSlice(
  db: SupabaseClient,
  req: BrandSliceRequest,
): Promise<BrandSlice> {
  const query = req.query?.trim();
  if (!query) {
    throw new Error('retrieveBrandSlice requires a non-empty query');
  }
  const k = req.k ?? BRAND_OBJECT_CONFIG.retrieval.defaultK;

  // Live, non-rejected facts are the authority on confidence/status; chunks
  // are the retrieval index.
  const { data: factRows, error: factError } = await db
    .from('brand_facts')
    .select(
      'id, fact_key, section, statement, details, confidence, status, metrics, evidence',
    )
    .eq('organization_id', req.organizationId)
    .eq('brand_profile_id', req.brandProfileId)
    .is('valid_to', null)
    .neq('status', 'rejected');
  if (factError) throw factError;
  const liveFacts = (factRows ?? []) as unknown as LiveFactRow[];
  const factById = new Map(liveFacts.map((row) => [String(row.id), row]));

  let chunkQuery = db
    .from('brand_chunks')
    .select('fact_id, section, persona_key, awareness_stage, embedding')
    .eq('organization_id', req.organizationId)
    .eq('brand_profile_id', req.brandProfileId)
    .eq('embedding_model', EMBEDDING_MODEL)
    .not('embedding', 'is', null)
    .neq('section', 'compliance');
  if (req.sections && req.sections.length > 0) {
    chunkQuery = chunkQuery.in(
      'section',
      req.sections.filter((section) => section !== 'compliance'),
    );
  }
  const { data: chunkRows, error: chunkError } = await chunkQuery;
  if (chunkError) throw chunkError;

  const chunks: ChunkForRank[] = [];
  for (const row of chunkRows ?? []) {
    const vector = parseVectorLiteral(row.embedding);
    if (!vector || !factById.has(String(row.fact_id))) continue;
    chunks.push({
      factId: String(row.fact_id),
      section: String(row.section),
      personaKey: (row.persona_key as string | null) ?? null,
      awarenessStage: (row.awareness_stage as string | null) ?? null,
      vector,
    });
  }

  let ranked: ReturnType<typeof rankChunks> = [];
  if (chunks.length > 0) {
    const [queryVector] = await embedTexts([query]);
    ranked = rankChunks(
      chunks,
      queryVector,
      new Map(liveFacts.map((row) => [String(row.id), Number(row.confidence)])),
      {
        sections: req.sections,
        personaKey: req.personaKey,
        awarenessStage: req.awarenessStage,
      },
      k,
    );
  }

  const facts = ranked
    .map((item) => {
      const row = factById.get(item.factId);
      return row ? toRetrievedFact(row, item.score) : null;
    })
    .filter((fact): fact is RetrievedFact => fact !== null);

  const rankedIds = new Set(facts.map((fact) => fact.factId));
  const complianceFacts = liveFacts
    .filter(
      (row) => row.section === 'compliance' && !rankedIds.has(String(row.id)),
    )
    .map((row) => toRetrievedFact(row, 1));

  return {
    facts,
    complianceFacts,
    provenanceFactIds: [
      ...facts.map((fact) => fact.factId),
      ...complianceFacts.map((fact) => fact.factId),
    ],
    meta: { retrievedAt: new Date().toISOString() },
  };
}

function toRetrievedFact(row: LiveFactRow, score: number): RetrievedFact {
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  return {
    factId: String(row.id),
    factKey: String(row.fact_key),
    section: row.section as BrandSection,
    statement: String(row.statement),
    details: row.details ?? {},
    bestVerbatim: evidence.find((ref) => ref.quote)?.quote,
    confidence: Number(row.confidence),
    status: row.status as Exclude<FactStatus, 'rejected'>,
    metrics: row.metrics ?? {},
    evidence,
    score: Math.round(score * 1000) / 1000,
  };
}

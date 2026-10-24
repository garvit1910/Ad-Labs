/**
 * The sanctioned BULK-SYNC read door for the Brand Object.
 *
 * `retrieveBrandSlice` (retrieval/service.ts) stays the one door for
 * generation-time reads (query-required, top-k, compliance-appended). This
 * reader exists for the two consumers that legitimately need EVERY live fact
 * at once — the AI-narrative synthesis pack and the brand-context-layer
 * one-directional ingest (lib/creative-engine/brand-context). Nothing else
 * may query `brand_facts` directly; see lib/brand-object/CLAUDE.md.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { InsightFact } from './insights';

const FACT_COLUMNS =
  'id, section, fact_key, statement, details, confidence, status, evidence, metrics';

export interface BrandFactScope {
  organizationId: string;
  brandProfileId: string;
}

function mapFact(row: Record<string, unknown>): InsightFact {
  return {
    id: String(row.id),
    section: row.section as InsightFact['section'],
    fact_key: String(row.fact_key),
    statement: String(row.statement),
    details: (row.details as Record<string, unknown>) ?? {},
    confidence: Number(row.confidence ?? 0),
    status: (row.status as InsightFact['status']) ?? 'candidate',
    evidence: (row.evidence as InsightFact['evidence']) ?? [],
    metrics: (row.metrics as InsightFact['metrics']) ?? {},
  };
}

/** Every live, non-rejected fact for the profile (valid_to IS NULL). */
export async function loadLiveBrandFacts(
  db: SupabaseClient,
  scope: BrandFactScope,
): Promise<InsightFact[]> {
  const { data, error } = await db
    .from('brand_facts')
    .select(FACT_COLUMNS)
    .eq('organization_id', scope.organizationId)
    .eq('brand_profile_id', scope.brandProfileId)
    .is('valid_to', null)
    .neq('status', 'rejected');
  if (error) throw new Error(`load brand facts failed: ${error.message}`);
  return (data ?? []).map(mapFact);
}

/**
 * What this brand believed AT A POINT IN TIME — the bi-temporal replay read.
 *
 * `brand_facts` is append-only: a superseded row keeps its statement and gets
 * `valid_to` stamped, so "what did we believe last month, and why" is a
 * predicate over two columns rather than an audit log to reconstruct. A row is
 * live at T when it had already started (`valid_from <= T`) and had not yet
 * ended (`valid_to IS NULL OR valid_to > T`) — half-open, so a fact superseded
 * exactly at T is NOT returned and its replacement is, which keeps the result
 * to one row per identity across the supersession boundary.
 *
 * Rejected rows are excluded exactly as in the live read: a founder rejection
 * is a statement about the fact, not about the point in time.
 */
export async function loadBrandFactsAsOf(
  db: SupabaseClient,
  scope: BrandFactScope,
  /** ISO timestamp. */
  asOf: string,
): Promise<InsightFact[]> {
  const { data, error } = await db
    .from('brand_facts')
    .select(FACT_COLUMNS)
    .eq('organization_id', scope.organizationId)
    .eq('brand_profile_id', scope.brandProfileId)
    .lte('valid_from', asOf)
    .or(`valid_to.is.null,valid_to.gt.${asOf}`)
    .neq('status', 'rejected');
  if (error) throw new Error(`load brand facts as-of failed: ${error.message}`);
  return (data ?? []).map(mapFact);
}

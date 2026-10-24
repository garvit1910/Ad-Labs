/**
 * Executes a ReconcilePlan against brand_facts / brand_fact_suggestions.
 * Write-order invariant (regression-relevant): a supersede stamps the old
 * row's valid_to FIRST, then inserts the new version — the partial unique
 * live-identity index allows one live row per (profile, section, fact_key),
 * and a crash between the steps leaves no live row (safe: the next promotion
 * re-inserts). Rows are NEVER deleted here. All queries are explicitly
 * org+profile scoped (service role bypasses RLS).
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BrandSection,
  CandidateFact,
  EvidenceRef,
  FactMetrics,
  FactSource,
  FactStatus,
  LiveFact,
  ReconcilePlan,
} from '@/lib/brand-object/types';

const FACT_COLUMNS =
  'id, section, fact_key, statement, details, confidence, source, status, evidence, metrics, valid_from';

export interface FactRowShape {
  id: string;
  section: string;
  fact_key: string;
  statement: string;
  details: Record<string, unknown>;
  confidence: number;
  source: string;
  status: string;
  evidence: EvidenceRef[];
  metrics: FactMetrics;
  valid_from: string;
}

export function mapFactRow(row: FactRowShape): LiveFact {
  return {
    id: String(row.id),
    section: row.section as BrandSection,
    factKey: String(row.fact_key),
    statement: String(row.statement),
    details: row.details ?? {},
    confidence: Number(row.confidence),
    source: row.source as FactSource,
    status: row.status as FactStatus,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    metrics: row.metrics ?? {},
    validFrom: String(row.valid_from),
  };
}

/** Live rows (valid_to IS NULL, any status except rejected can't be live —
 * rejection stamps valid_to) for the given sections. */
export async function loadLiveFacts(
  supabase: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
  sections?: readonly string[],
): Promise<LiveFact[]> {
  let query = supabase
    .from('brand_facts')
    .select(FACT_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('brand_profile_id', brandProfileId)
    .is('valid_to', null);
  if (sections && sections.length > 0) {
    query = query.in('section', [...sections]);
  }
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as unknown as FactRowShape[]).map(mapFactRow);
}

/** section:factKey identities whose latest version was founder-rejected and
 * that have no live row — the reconciler suppresses their re-proposal. */
export async function loadRejectedKeys(
  supabase: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
  liveFacts: LiveFact[],
  sections?: readonly string[],
): Promise<Set<string>> {
  let query = supabase
    .from('brand_facts')
    .select('section, fact_key')
    .eq('organization_id', organizationId)
    .eq('brand_profile_id', brandProfileId)
    .eq('status', 'rejected');
  if (sections && sections.length > 0) {
    query = query.in('section', [...sections]);
  }
  const { data, error } = await query;
  if (error) throw error;
  const liveKeys = new Set(
    liveFacts.map((fact) => `${fact.section}:${fact.factKey}`),
  );
  const rejected = new Set<string>();
  for (const row of data ?? []) {
    const key = `${row.section}:${row.fact_key}`;
    if (!liveKeys.has(key)) rejected.add(key);
  }
  return rejected;
}

function candidateToRow(
  organizationId: string,
  brandProfileId: string,
  candidate: CandidateFact,
  previousVersionId?: string,
) {
  return {
    organization_id: organizationId,
    brand_profile_id: brandProfileId,
    section: candidate.section,
    fact_key: candidate.factKey,
    statement: candidate.statement,
    details: candidate.details,
    confidence: candidate.confidence,
    source: candidate.source,
    status: 'candidate',
    evidence: candidate.evidence,
    metrics: candidate.metrics,
    ...(previousVersionId ? { previous_version_id: previousVersionId } : {}),
  };
}

export function suggestionDedupeKey(
  factId: string,
  proposedStatement: string,
): string {
  return createHash('sha256')
    .update(`${factId}:${proposedStatement.toLowerCase().replace(/\s+/g, ' ').trim()}`)
    .digest('hex');
}

export interface ExecutedPlanCounts {
  inserted: number;
  superseded: number;
  suggested: number;
  refreshed: number;
}

export async function executeReconcilePlan(
  supabase: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
  plan: ReconcilePlan,
): Promise<ExecutedPlanCounts> {
  const counts: ExecutedPlanCounts = {
    inserted: 0,
    superseded: 0,
    suggested: 0,
    refreshed: 0,
  };
  const nowIso = new Date().toISOString();

  if (plan.inserts.length > 0) {
    const { error } = await supabase.from('brand_facts').insert(
      plan.inserts.map((candidate) =>
        candidateToRow(organizationId, brandProfileId, candidate),
      ),
    );
    if (error) throw error;
    counts.inserted = plan.inserts.length;
  }

  for (const { liveFactId, candidate } of plan.supersedes) {
    // Stamp-then-insert (see module header). The .is('valid_to', null) guard
    // makes a concurrent double-supersede lose harmlessly.
    const { data: stamped, error: stampError } = await supabase
      .from('brand_facts')
      .update({ valid_to: nowIso, updated_at: nowIso })
      .eq('id', liveFactId)
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .is('valid_to', null)
      .select('id')
      .maybeSingle();
    if (stampError) throw stampError;
    if (!stamped) continue; // someone else superseded/rejected it first
    const { error: insertError } = await supabase
      .from('brand_facts')
      .insert(
        candidateToRow(organizationId, brandProfileId, candidate, liveFactId),
      );
    if (insertError) throw insertError;
    counts.superseded++;
  }

  for (const { liveFactId, candidate, reason } of plan.suggestions) {
    const { error } = await supabase.from('brand_fact_suggestions').upsert(
      {
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        fact_id: liveFactId,
        proposed_statement: candidate.statement,
        proposed_details: candidate.details,
        evidence: candidate.evidence,
        reason,
        confidence: candidate.confidence,
        dedupe_key: suggestionDedupeKey(liveFactId, candidate.statement),
      },
      {
        onConflict: 'organization_id,dedupe_key',
        ignoreDuplicates: true,
      },
    );
    if (error) throw error;
    counts.suggested++;
  }

  for (const { liveFactId, candidate } of plan.metricRefreshes) {
    // Content-identical: fresher deterministic numbers + evidence only.
    // NEVER statement/details/confidence — on confirmed facts those are the
    // founder's.
    const { error } = await supabase
      .from('brand_facts')
      .update({
        metrics: candidate.metrics,
        evidence: candidate.evidence,
        updated_at: nowIso,
      })
      .eq('id', liveFactId)
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .is('valid_to', null);
    if (error) throw error;
    counts.refreshed++;
  }

  return counts;
}

/**
 * Retire auto-extracted facts a fresh extraction no longer produces: stamp
 * valid_to (append-only — never delete). Used by identity re-extraction,
 * where the whole section set is re-derived each run and a stale CANDIDATE
 * (never a confirmed fact — callers filter) should not linger as live.
 */
export async function retireFacts(
  supabase: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
  factIds: string[],
): Promise<number> {
  if (factIds.length === 0) return 0;
  const nowIso = new Date().toISOString();
  let retired = 0;
  for (const factId of factIds) {
    const { data, error } = await supabase
      .from('brand_facts')
      .update({ valid_to: nowIso, updated_at: nowIso })
      .eq('id', factId)
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .eq('status', 'candidate')
      .is('valid_to', null)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (data) retired++;
  }
  return retired;
}

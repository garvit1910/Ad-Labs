import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { claimHeadline, identityClaims, topVocBySection, type InsightFact, type VocInsightRow } from '@/lib/brand-object/insights';
import type { BrandSynthesis, BrandSynthesisFinding } from '@/lib/brand-object/synthesis/types';
import { dbError } from './http';

/**
 * Brand facts for the Brand Identity page (A7). Server-only.
 *
 * Live facts are `valid_to IS NULL AND status <> 'rejected'`. The portfolio
 * route counts with exactly the same two filters, so
 * `portfolio.liveFactCount === facts.length` always holds.
 */

export const FACT_VIEW_COLUMNS =
  'id, section, fact_key, statement, details, confidence, source, status, evidence, metrics, valid_from, updated_at';

/** The facts route's row: the hooks' BrandFactView plus `updated_at`. */
export type FactView = InsightFact & { source: string; valid_from: string; updated_at: string };

export async function loadFactViews(db: SupabaseClient, brandProfileId: string): Promise<FactView[]> {
  const { data, error } = await db
    .from('brand_facts')
    .select(FACT_VIEW_COLUMNS)
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('brand_profile_id', brandProfileId)
    .is('valid_to', null) // live-fact predicate: keep in sync with brand-object/portfolio
    .neq('status', 'rejected')
    .order('section')
    .order('confidence', { ascending: false });
  if (error) throw dbError('Failed to load brand facts', error);
  return (data ?? []) as unknown as FactView[];
}

export interface SynthesisScope {
  organizationId: string;
  brandProfileId: string;
  brandName: string | null;
}

const VOC_LABEL: Record<string, string> = {
  voc_praise: 'VOC praise',
  voc_pain: 'VOC pain',
  voc_objection: 'VOC objection',
};

/**
 * One finding from a VOC row: the stored statement as the point, and the
 * real mention count plus the substring-verified verbatim as evidence, in the
 * grammar narrative-evidence.ts parses ("VOC praise 28 mentions; verbatim:
 * \"...\""). A verbatim containing a double quote is dropped, not edited,
 * because it would break the quote-aware split.
 */
function vocFinding(row: VocInsightRow): BrandSynthesisFinding {
  const parts = [`${VOC_LABEL[row.section] ?? row.section} ${row.frequency} mentions`];
  if (row.verbatim && !row.verbatim.includes('"')) parts.push(`verbatim: "${row.verbatim}"`);
  return { point: row.statement, evidence: parts.join('; ') };
}

function perSectionCounts(facts: InsightFact[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fact of facts) counts[fact.section] = (counts[fact.section] ?? 0) + 1;
  return counts;
}

function fingerprint(facts: InsightFact[]): string {
  return createHash('sha256')
    .update(facts.map((f) => f.id).sort().join(','))
    .digest('hex');
}

function latestUpdate(facts: InsightFact[]): string {
  const stamps = facts.map((f) => f.updated_at).filter((s): s is string => typeof s === 'string');
  return stamps.length > 0 ? stamps.reduce((a, b) => (a > b ? a : b)) : new Date().toISOString();
}

/**
 * Chapter 02's narrative, assembled deterministically from live brand facts
 * (Ad Lab never ported Adcero's LLM synthesis service). No LLM, no invented
 * text: the headline is the positioning claim's first clause, the story is
 * the positioning and top value_prop statements, strengths are the top
 * voc_praise facts and tensions the top voc_pain and voc_objection facts,
 * ranked exactly as Chapter 03 ranks them. Null without a positioning fact.
 */
export function assembleSynthesis(facts: InsightFact[], scope: SynthesisScope): BrandSynthesis | null {
  const positioning = identityClaims(facts, ['positioning'], 1)[0];
  if (!positioning) return null;

  const valueProps = identityClaims(facts, ['value_prop'], 2)
    .map((c) => c.statement)
    .join(' ');
  const voc = topVocBySection(facts, 3);
  const strengths = (voc.voc_praise ?? []).slice(0, 3).map(vocFinding);
  const tensions = [...(voc.voc_pain ?? []).slice(0, 2), ...(voc.voc_objection ?? []).slice(0, 1)].map(vocFinding);
  const stamp = latestUpdate(facts);

  return {
    id: `deterministic:${scope.brandProfileId}`,
    organizationId: scope.organizationId,
    brandProfileId: scope.brandProfileId,
    status: 'ready',
    trigger: 'deterministic',
    headline: claimHeadline(positioning.statement, { maxLength: null }),
    story: [positioning.statement, valueProps].filter((s) => s.trim().length > 0),
    strengths,
    tensions,
    watchItems: [],
    hypotheses: [],
    inputsFingerprint: fingerprint(facts),
    factsCount: facts.length,
    model: null,
    cost: null,
    inputSnapshot: {
      factsCount: facts.length,
      perSectionCounts: perSectionCounts(facts),
      completenessOverall: null,
      brandName: scope.brandName,
    },
    generatedBy: null,
    generatedByType: 'system',
    error: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** The POST answer when there is no positioning fact to build from. */
export function skippedSynthesis(scope: SynthesisScope, facts: InsightFact[]): BrandSynthesis {
  const stamp = new Date().toISOString();
  return {
    id: `deterministic:${scope.brandProfileId}`,
    organizationId: scope.organizationId,
    brandProfileId: scope.brandProfileId,
    status: 'skipped',
    trigger: 'deterministic',
    headline: null,
    story: [],
    strengths: [],
    tensions: [],
    watchItems: [],
    hypotheses: [],
    inputsFingerprint: fingerprint(facts),
    factsCount: facts.length,
    model: null,
    cost: null,
    inputSnapshot: {
      factsCount: facts.length,
      perSectionCounts: perSectionCounts(facts),
      completenessOverall: null,
      brandName: scope.brandName,
    },
    generatedBy: null,
    generatedByType: 'system',
    error: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

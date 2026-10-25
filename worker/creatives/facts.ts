import type { SupabaseClient } from '@supabase/supabase-js';
import { loadBrandProfile } from '@/lib/adlab/brand-profile';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { loadLiveBrandFacts } from '@/lib/brand-object/live-facts';
import { buildDesiredRows, type UpstreamFact } from '@/lib/creative-engine/brand-context/ingest';
import type { BrandContextRow } from '@/lib/creative-engine/brand-context/types';

/**
 * Competitor sections. Ingest would land their statements as ordinary brand
 * facts ("Winning competitor ads use … in 7 of 12"), where they can win a pack
 * slot and ground numbers (CREATIVE_MANIFEST §11.3), so they never get that far.
 */
const COMPETITOR_SECTIONS = new Set(['market_prior', 'competitor_intel']);

export interface ClientRows {
  brandProfileId: string;
  rows: BrandContextRow[];
  /** Competitor facts dropped before ingest. */
  dropped: number;
}

/** Brand facts → compiler rows, the way the fixture generator ran ingest (no brand kit, version 1). */
export function toRows(facts: UpstreamFact[]): BrandContextRow[] {
  return buildDesiredRows(facts, null).map(({ rowId, rowType, priority, tagFilters, content }) => ({
    rowId,
    rowType,
    version: 1,
    priority,
    tagFilters,
    content,
  }));
}

/** Magic Spoon's live facts as compiler rows, recompiled every run and never stored. */
export async function loadClientRows(db: SupabaseClient): Promise<ClientRows> {
  const profile = await loadBrandProfile(db);
  const facts = await loadLiveBrandFacts(db, { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id });
  const kept = facts.filter((fact) => !COMPETITOR_SECTIONS.has(fact.section));
  return { brandProfileId: profile.id, rows: toRows(kept), dropped: facts.length - kept.length };
}

// Segment ↔ persona row ids are the contract's (lib/adlab/contract.ts).
export { personaRefFor, segmentIdForPersonaRow } from '@/lib/adlab/contract';

const statement = (row: BrandContextRow) => String(row.content.statement ?? '');
const section = (row: BrandContextRow) => String(row.content.section ?? '');

/** The brief's persona text, as brand mode writes it: "name: description". */
export function personaAudience(persona: BrandContextRow): string {
  return `${String(persona.content.name ?? '')}: ${String(persona.content.description ?? '')}`;
}

/** Value-prop statements, strongest first (composeBrief reads the first two). */
export function valuePropositions(rows: BrandContextRow[]): string[] {
  return rows
    .filter((row) => row.rowType === 'fact' && section(row) === 'value_prop')
    .sort((a, b) => b.priority - a.priority || (a.rowId < b.rowId ? -1 : 1))
    .map(statement);
}

const KEY_SECTION_RANK: Record<string, number> = { proof_point: 0, usp: 1 };

/**
 * The strongest proof_point or usp fact tagged with the angle's theme, pinned
 * as the pack's key message so the brief's key claim always reaches the
 * copywriter (CREATIVE_MANIFEST §11.5). Ranked: facts this persona cites
 * first, then proof points, then facts that state a number, then priority and
 * row id. Pass the segment's own rows (`segmentRows`).
 */
export function keyMessageFor(rows: BrandContextRow[], angle: string, personaRef: string): BrandContextRow | undefined {
  const cited = (row: BrandContextRow) => Number(row.tagFilters.audiences?.includes(personaRef) ?? false);
  const hasNumber = (row: BrandContextRow) => Number(/\d/.test(statement(row)));
  return rows
    .filter(
      (row) =>
        row.rowType === 'fact' &&
        section(row) in KEY_SECTION_RANK &&
        Array.isArray(row.tagFilters.themes) &&
        row.tagFilters.themes.includes(angle),
    )
    .sort(
      (a, b) =>
        cited(b) - cited(a) ||
        KEY_SECTION_RANK[section(a)] - KEY_SECTION_RANK[section(b)] ||
        hasNumber(b) - hasNumber(a) ||
        b.priority - a.priority ||
        (a.rowId < b.rowId ? -1 : 1),
    )[0];
}

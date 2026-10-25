import { rowMatchesSpec } from '@/lib/creative-engine/brand-context/compile';
import type { BrandContextRow, TagFilters } from '@/lib/creative-engine/brand-context/types';
import { HOOK_PRODUCIBILITY, type HookRequirement } from '@/lib/creative-engine/generation/producibility';
import type { StrategyPackHints } from '@/lib/creative-engine/generation/strategy';

/**
 * The briefs route's pack hints (Adcero `brief-helpers.ts:73-103`), verbatim
 * from CREATIVE_MANIFEST §4: which fact-backed hooks the rows can carry.
 */
export function derivePackHints(rows: BrandContextRow[]): StrategyPackHints {
  const facts = rows.filter((r) => r.rowType === 'fact');
  return {
    hasNumericFact: facts.some((r) => /\d/.test(String(r.content.statement ?? ''))),
    hasSocialProofFact: facts.some((r) => ['proof_point', 'voc_praise'].includes(String(r.content.section ?? ''))),
    hasCustomerVerbatim: rows.some(
      (r) => r.rowType === 'persona' && Array.isArray(r.content.verbatims) && r.content.verbatims.length > 0,
    ),
    hasOfferFact: facts.some((r) =>
      /(discount|% off|free shipping|free trial|bundle|money.?back|guarantee)/i.test(String(r.content.statement ?? '')),
    ),
  };
}

/** The spec tags `compile` builds for a persona's pack (compile.ts, `specTags`). */
function personaSpecTags(persona: BrandContextRow): Required<TagFilters> {
  const stage = persona.content.awarenessStage;
  return {
    channels: ['meta'],
    products: [],
    audiences: [persona.rowId],
    stages: typeof stage === 'string' ? [stage] : [],
    themes: [],
  };
}

/**
 * The rows one persona's pack can draw from: that persona, plus every other
 * non-persona row its spec tags admit. Pack hints over these are the
 * segment's own, so a persona without verbatims can't borrow another's.
 */
export function segmentRows(rows: BrandContextRow[], personaRowId: string): BrandContextRow[] {
  const persona = rows.find((row) => row.rowType === 'persona' && row.rowId === personaRowId);
  if (!persona) return [];
  const tags = personaSpecTags(persona);
  return rows.filter((row) =>
    row.rowType === 'persona' ? row === persona : rowMatchesSpec(row.tagFilters, tags),
  );
}

const REQUIREMENT_MET: Record<HookRequirement, (hints: StrategyPackHints) => boolean> = {
  numeric_fact: (hints) => hints.hasNumericFact,
  social_proof_fact: (hints) => hints.hasSocialProofFact,
  customer_verbatim: (hints) => hints.hasCustomerVerbatim,
  offer_fact: (hints) => hints.hasOfferFact,
};

/**
 * Why the copywriter can't produce this hook under these hints, or null if it
 * can: `not_producible` for a never-producible or unknown hook, else the unmet
 * HOOK_PRODUCIBILITY requirement.
 */
export function missingRequirement(hook: string, hints: StrategyPackHints): string | null {
  const entry = HOOK_PRODUCIBILITY[hook as keyof typeof HOOK_PRODUCIBILITY];
  if (!entry || entry.status === 'not_producible') return 'not_producible';
  if (entry.requires && !REQUIREMENT_MET[entry.requires](hints)) return entry.requires;
  return null;
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import type { InsightFact } from '@/lib/brand-object/insights';
import { loadLiveBrandFacts } from '@/lib/brand-object/live-facts';
import { loadBrandProfile, loadMentionText } from '@/lib/adlab/brand-profile';
import type { Spacetime } from '../spacetime-http';
import { type ArmReport, buildArms } from './arms';
import type { BrandRow, ConceptRow, PersonaInfo, ProductRow, World } from './check';
import { type LiveCreatives, buildLiveCreatives, loadAds } from './live-ads';
import type { Llm } from './llm';
import { type SegmentReport, buildSegments } from './segments';
import { CONCEPTS, type FactHints, factHints, segmentIdFor } from './vocabulary';

/*
 * Builds every row A4 writes, in memory. Writes nothing: the CLI
 * (scripts/a4-build-rows.ts) and, later, A6's contract/build endpoint decide.
 */

/** B's fixture id for Magic Spoon's landing product (sim/fixtures/magicspoon/products.json). */
export const FALLBACK_PRODUCT_ID = 'prd_magic_spoon_variety_4pk';

export interface ContractRows {
  world: World;
  segments: SegmentReport[];
  arms: ArmReport[];
  live: LiveCreatives;
  hints: FactHints;
  personas: PersonaInfo[];
  facts: InsightFact[];
  landingProductId: string;
}

/** Each live persona's segment id and whether it has verbatims (testimonial needs them). */
export function personaInfo(facts: InsightFact[]): PersonaInfo[] {
  return facts
    .filter((fact) => fact.section === 'persona')
    .map((fact) => ({
      segmentId: segmentIdFor(fact.fact_key),
      hasVerbatims: Array.isArray(fact.details.verbatims) && fact.details.verbatims.length > 0,
    }));
}

export async function loadFacts(db: SupabaseClient): Promise<{ facts: InsightFact[]; brandProfileId: string }> {
  const profile = await loadBrandProfile(db);
  const facts = await loadLiveBrandFacts(db, { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id });
  return { facts, brandProfileId: profile.id };
}

export async function buildContractRows(opts: {
  db: SupabaseClient;
  spacetime: Spacetime;
  llm: Llm;
  log: (message: string) => void;
}): Promise<ContractRows> {
  const { db, spacetime, llm, log } = opts;
  const { facts, brandProfileId } = await loadFacts(db);
  const [mentions, { pages, ads }, products] = await Promise.all([
    loadMentionText(db, brandProfileId),
    loadAds(db, brandProfileId),
    spacetime.sql<ProductRow>('SELECT * FROM product'),
  ]);
  log(`${facts.length} live facts, ${mentions.size} mentions, ${pages.length} pages, ${ads.length} labelled ads, ${products.length} products in SpacetimeDB`);

  const self = pages.filter((page) => page.isSelf);
  if (self.length !== 1) throw new Error(`expected one is_brand_self page, found ${self.length}`);
  const clientProducts = products.filter((product) => product.brand_id === self[0].brandId).sort((a, b) => a.product_id.localeCompare(b.product_id));
  const landingProductId = clientProducts[0]?.product_id ?? FALLBACK_PRODUCT_ID;
  if (clientProducts.length === 0) {
    log(`WARN: B's product table has no ${self[0].brandId} product; brand_live rows land on ${FALLBACK_PRODUCT_ID}, which B must write`);
  }

  const hints = factHints(facts);
  const live = buildLiveCreatives(pages, ads, landingProductId);
  const [segments, arms] = await Promise.all([
    buildSegments({ facts, mentions, llm }),
    buildArms({ pages, ads, facts, live, hints, llm, log }),
  ]);

  const brands: BrandRow[] = pages.map((page) => ({ brand_id: page.brandId, name: page.name, is_client: page.isSelf }));
  const concepts: ConceptRow[] = CONCEPTS.map((concept) => ({ concept_id: `cpt_${concept.key}`, key: concept.key, label: concept.label }));
  // Competitor ads first, Magic Spoon's last: a brand_live row in the control is A5's "A4 is done" signal.
  const creatives = [
    ...live.rows.filter((row) => row.origin === 'competitor_live'),
    ...live.rows.filter((row) => row.origin === 'brand_live'),
  ];
  return {
    world: {
      brands,
      concepts,
      segments: segments.map((segment) => segment.row),
      arms: arms.map((arm) => arm.row),
      creatives,
      products,
    },
    segments,
    arms,
    live,
    hints,
    personas: personaInfo(facts),
    facts,
    landingProductId,
  };
}

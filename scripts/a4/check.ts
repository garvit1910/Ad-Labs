import { checkContract, printContractCheck, type ContractCheck, type PersonaInfo } from '@/lib/adlab/contract-check';
import type { StrategyPackHints } from '@/lib/creative-engine/generation/strategy';
import type { ArmRow } from './arms';
import type { CreativeRow } from './live-ads';
import type { SegmentRow } from './segments';
import { hookRequirement } from './vocabulary';

/*
 * A4's view of the shared contract check (lib/adlab/contract-check.ts, which A5 runs
 * too): the same function checks the rows before they are written and what
 * SpacetimeDB holds afterwards.
 */

export type { PersonaInfo };

export interface BrandRow {
  brand_id: string;
  name: string;
  is_client: boolean;
}

export interface ConceptRow {
  concept_id: string;
  key: string;
  label: string;
}

export interface ProductRow {
  product_id: string;
  brand_id: string;
  name: string;
}

export interface World {
  brands: BrandRow[];
  concepts: ConceptRow[];
  segments: SegmentRow[];
  arms: ArmRow[];
  creatives: CreativeRow[];
  products: ProductRow[];
}

export interface CheckResult extends ContractCheck {
  /** (recipe, segment) pairs A5 skips by design: the hook's requirement isn't met for that segment. */
  skips: string[];
}

export function checkWorld(world: World, personas: PersonaInfo[], hints: StrategyPackHints): CheckResult {
  const result = checkContract(world, personas, hints);
  const skips: string[] = [];
  for (const arm of world.arms.filter((candidate) => candidate.strategy !== 'control')) {
    if (hookRequirement(arm.hook) !== 'customer_verbatim') continue;
    for (const persona of personas) {
      if (!persona.hasVerbatims) skips.push(`${arm.arm_id} × ${persona.segmentId}: ${arm.hook} needs customer_verbatim; the segment's persona has no verbatims`);
    }
  }
  return { ...result, skips };
}

export function printCheck(title: string, result: CheckResult): void {
  printContractCheck(title, result);
  if (result.skips.length) {
    console.log('\n(recipe, segment) pairs A5 skips by design');
    for (const skip of result.skips) console.log(`  ${skip}`);
  }
}

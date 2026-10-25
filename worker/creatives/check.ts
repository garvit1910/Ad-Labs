import { CONTROL_ARM_ID, segmentIdForPersonaRow } from '@/lib/adlab/contract';
import { checkContract, type ContractCheck, type ContractWorld, type PersonaInfo } from '@/lib/adlab/contract-check';
import type { Spacetime } from '@/lib/adlab/spacetime-http';
import type { BrandContextRow } from '@/lib/creative-engine/brand-context/types';
import { derivePackHints } from './pack-hints';
import { planPairs } from './pairs';
import type { ClientBrand, Recipe, Segment, Skip } from './types';

/** A's rows and B's products as SQL returns them. */
export type A4Tables = ContractWorld;

export async function readA4Tables(spacetime: Spacetime): Promise<A4Tables> {
  const [brands, concepts, segments, arms, creatives, products] = await Promise.all([
    spacetime.sql('SELECT * FROM brand'),
    spacetime.sql('SELECT * FROM concept'),
    spacetime.sql('SELECT * FROM segment'),
    spacetime.sql('SELECT * FROM arm'),
    spacetime.sql('SELECT * FROM creative'),
    spacetime.sql('SELECT * FROM product'),
  ]);
  return { brands, concepts, segments, arms, creatives, products } as unknown as A4Tables;
}

export interface CheckResult extends ContractCheck {
  /** Every FAIL line; empty when A4's rows (and B's product) are usable for writing creatives. */
  failures: string[];
  warnings: string[];
  brand?: ClientBrand;
  segments: Segment[];
  /** The non-control recipes. */
  recipes: Recipe[];
  controlArmId?: string;
  landingProductId: string;
  skips: Skip[];
  /** recipes × segments minus the logged skips: round 0's creative count. */
  expected: number;
}

const evidenceList = (evidence: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(evidence);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

/** The live persona facts, as the segments A4 builds from them (the compiler's persona rows). */
export function personasFromRows(rows: BrandContextRow[]): PersonaInfo[] {
  return rows
    .filter((row) => row.rowType === 'persona')
    .map((row) => ({
      segmentId: segmentIdForPersonaRow(row.rowId),
      hasVerbatims: Array.isArray(row.content.verbatims) && row.content.verbatims.length > 0,
    }));
}

/**
 * Whether A4's rows have landed and are usable for writing creatives: the shared
 * contract check (lib/adlab/contract-check.ts, the one A4 runs), plus the pairs A5
 * will skip and round 0's expected count. Lists every failure, never just the first.
 */
export function checkA4Rows(tables: A4Tables, rows: BrandContextRow[]): CheckResult {
  const contract = checkContract(tables, personasFromRows(rows), derivePackHints(rows));
  const failures = contract.lines.filter((line) => line.level === 'FAIL').map((line) => line.text);
  const warnings = contract.lines.filter((line) => line.level === 'WARN').map((line) => line.text);

  const clients = tables.brands.filter((brand) => brand.is_client);
  const brand = clients.length === 1 ? { brand_id: clients[0].brand_id, name: clients[0].name } : undefined;
  const segments = [...tables.segments]
    .sort((a, b) => (a.segment_id < b.segment_id ? -1 : 1))
    .map(({ segment_id, name, share }) => ({ segment_id, name, share }));
  const arms = [...tables.arms].sort((a, b) => (a.arm_id < b.arm_id ? -1 : 1));
  const recipes: Recipe[] = arms
    .filter((arm) => arm.strategy !== 'control')
    .map(({ arm_id, angle, hook, strategy, evidence }) => ({ arm_id, angle, hook, strategy, rationale: '', evidence: evidenceList(evidence) }));
  const controlArmId = arms.some((arm) => arm.arm_id === CONTROL_ARM_ID && arm.strategy === 'control') ? CONTROL_ARM_ID : undefined;

  const products = brand
    ? tables.products.filter((product) => product.brand_id === brand.brand_id).sort((a, b) => (a.product_id < b.product_id ? -1 : 1))
    : [];
  // Generated ads land where Magic Spoon's live ads do, so the control and the recipes sell the same page.
  const landing =
    products.find((product) => tables.creatives.some((c) => c.origin === 'brand_live' && c.landing_product_id === product.product_id)) ??
    products[0];
  if (products.length > 1) warnings.push(`product: ${products.length} rows for ${brand?.brand_id}; landing on ${landing.product_id}`);

  const { skips } = planPairs(recipes, segments.map((segment) => segment.segment_id), rows);
  return {
    ...contract,
    failures,
    warnings,
    ...(brand ? { brand } : {}),
    segments,
    recipes,
    ...(controlArmId ? { controlArmId } : {}),
    landingProductId: landing?.product_id ?? '',
    skips,
    expected: recipes.length * segments.length - skips.length,
  };
}

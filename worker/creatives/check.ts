import type { BrandContextRow } from '@/lib/creative-engine/brand-context/types';
import { HOOK_ARCHETYPES } from '@/services/ad-library/label-taxonomy';
import { personaRefFor } from './facts';
import { planPairs } from './pairs';
import type { Stdb } from './spacetime';
import { FOOD_ANGLES } from './strategy-from-arms';
import type { ClientBrand, Recipe, Segment, Skip } from './types';

/** A4's rows (and B's products) as SQL returns them. */
export interface A4Tables {
  brands: Array<{ brand_id: string; name: string; is_client: boolean }>;
  segments: Array<{ segment_id: string; name: string; share: number }>;
  arms: Array<{ arm_id: string; angle: string; hook: string; strategy: string; rationale: string; evidence: string }>;
  /** creative rows with origin brand_live. */
  brandLive: Array<{ creative_id: string; arm_id: string }>;
  products: Array<{ product_id: string; brand_id: string; name: string }>;
}

export async function readA4Tables(stdb: Stdb): Promise<A4Tables> {
  const [brands, segments, arms, brandLive, products] = await Promise.all([
    stdb.sql('SELECT * FROM brand'),
    stdb.sql('SELECT * FROM segment'),
    stdb.sql('SELECT * FROM arm'),
    stdb.sql("SELECT * FROM creative WHERE origin = 'brand_live'"),
    stdb.sql('SELECT * FROM product'),
  ]);
  return { brands, segments, arms, brandLive, products } as unknown as A4Tables;
}

export interface CheckResult {
  /** Empty when A4's rows are usable. */
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

const SHARE_TOLERANCE = 1e-6;
const HOOKS = new Set<string>(HOOK_ARCHETYPES);

function parseEvidence(armId: string, evidence: string, failures: string[]): string[] {
  try {
    const parsed: unknown = JSON.parse(evidence);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // reported below
  }
  failures.push(`arm ${armId}: evidence is not a JSON array of strings`);
  return [];
}

/**
 * Whether A4's rows have landed and are usable for writing creatives. Lists
 * every failure, never just the first.
 */
export function checkA4Rows(tables: A4Tables, rows: BrandContextRow[]): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  const clients = tables.brands.filter((brand) => brand.is_client);
  if (clients.length !== 1) failures.push(`brand: expected exactly one is_client row, found ${clients.length}`);
  const brand = clients.length === 1 ? { brand_id: clients[0].brand_id, name: clients[0].name } : undefined;

  const segments = [...tables.segments].sort((a, b) => (a.segment_id < b.segment_id ? -1 : 1));
  if (segments.length < 2) failures.push(`segment: expected at least 2 rows, found ${segments.length}`);
  const shareSum = segments.reduce((sum, segment) => sum + segment.share, 0);
  if (segments.length > 0 && Math.abs(shareSum - 1) > SHARE_TOLERANCE) failures.push(`segment: shares sum to ${shareSum}, not 1`);
  const personaIds = new Set(rows.filter((row) => row.rowType === 'persona').map((row) => row.rowId));
  for (const segment of segments) {
    const personaRef = personaRefFor(segment.segment_id);
    if (!personaIds.has(personaRef)) failures.push(`segment ${segment.segment_id}: no live persona fact (${personaRef})`);
  }

  const arms = [...tables.arms].sort((a, b) => (a.arm_id < b.arm_id ? -1 : 1));
  const controls = arms.filter((arm) => arm.strategy === 'control');
  if (controls.length !== 1) failures.push(`arm: expected exactly one control arm, found ${controls.length}`);
  const recipes: Recipe[] = arms
    .filter((arm) => arm.strategy !== 'control')
    .map((arm) => ({ ...arm, evidence: parseEvidence(arm.arm_id, arm.evidence, failures) }));
  if (recipes.length < 10 || recipes.length > 12) failures.push(`arm: expected 10-12 recipes plus the control, found ${recipes.length}`);
  const seen = new Map<string, string>();
  for (const recipe of recipes) {
    if (!FOOD_ANGLES.includes(recipe.angle)) failures.push(`arm ${recipe.arm_id}: angle "${recipe.angle}" is not a food-industry token`);
    if (!HOOKS.has(recipe.hook)) failures.push(`arm ${recipe.arm_id}: hook "${recipe.hook}" is not a HOOK_ARCHETYPE`);
    const pair = `${recipe.angle}|${recipe.hook}`;
    const other = seen.get(pair);
    if (other) failures.push(`arm ${recipe.arm_id}: same (angle, hook) as ${other}`);
    else seen.set(pair, recipe.arm_id);
  }

  const controlArmId = controls.length === 1 ? controls[0].arm_id : undefined;
  if (controlArmId && !tables.brandLive.some((creative) => creative.arm_id === controlArmId)) {
    failures.push(`creative: the control arm ${controlArmId} has no brand_live creative yet (A4 writes them last)`);
  }

  // B's engine throws on an impression of a creative with no landing product, so writes need one.
  const products = brand
    ? tables.products.filter((product) => product.brand_id === brand.brand_id).sort((a, b) => (a.product_id < b.product_id ? -1 : 1))
    : [];
  if (products.length === 0) {
    failures.push(
      `product: no product row for ${brand?.brand_id ?? 'the client brand'} yet (B's); generated creatives need a landing_product_id`,
    );
  }
  if (products.length > 1) warnings.push(`product: ${products.length} rows for ${brand?.brand_id}; landing on ${products[0].product_id}`);
  const landingProductId = products[0]?.product_id ?? '';

  const segmentList = segments.map(({ segment_id, name, share }) => ({ segment_id, name, share }));
  const { skips } = planPairs(recipes, segmentList.map((segment) => segment.segment_id), rows);
  return {
    failures,
    warnings,
    ...(brand ? { brand } : {}),
    segments: segmentList,
    recipes,
    ...(controlArmId ? { controlArmId } : {}),
    landingProductId,
    skips,
    expected: recipes.length * segmentList.length - skips.length,
  };
}

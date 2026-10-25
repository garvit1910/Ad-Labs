import type { StrategyPackHints } from '@/lib/creative-engine/generation/strategy';
import type { ArmRow } from './arms';
import type { CreativeRow } from './live-ads';
import type { SegmentRow } from './segments';
import { ANGLES, CONTROL_ARM_ID, allowedHooks, hookRequirement } from './vocabulary';

/*
 * The rules no single reducer can check (reducers_a.ts header): whole-table counts,
 * shares, evidence and landing products. The same function checks the rows before
 * they are written and what SpacetimeDB holds afterwards, and covers A5's
 * "Running alongside A4" list plus B's checkWorld errors on A's tables.
 */

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
}

export interface World {
  brands: BrandRow[];
  concepts: ConceptRow[];
  segments: SegmentRow[];
  arms: ArmRow[];
  creatives: CreativeRow[];
  products: ProductRow[];
}

export interface PersonaInfo {
  segmentId: string;
  hasVerbatims: boolean;
}

export interface CheckResult {
  lines: Array<{ level: 'PASS' | 'WARN' | 'FAIL'; text: string }>;
  /** (recipe, segment) pairs A5 skips by design: the hook's requirement isn't met for that segment. */
  skips: string[];
  failed: boolean;
}

const EXPECTED_BRANDS = 8;
const QUOTES_WANTED = 8;
const SHARE_TOLERANCE = 1e-6;

const json = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function checkWorld(world: World, personas: PersonaInfo[], hints: StrategyPackHints): CheckResult {
  const lines: CheckResult['lines'] = [];
  const pass = (ok: boolean, text: string, level: 'FAIL' | 'WARN' = 'FAIL') => lines.push({ level: ok ? 'PASS' : level, text });

  const clients = world.brands.filter((brand) => brand.is_client);
  pass(clients.length === 1, `exactly one client brand (${clients.map((brand) => brand.brand_id).join(', ') || 'none'})`);
  pass(world.brands.length === EXPECTED_BRANDS, `${world.brands.length} brands (Magic Spoon and the seven competitors: ${EXPECTED_BRANDS})`, 'WARN');
  const clientId = clients[0]?.brand_id ?? '';

  const conceptKeys = new Set(world.concepts.map((concept) => concept.key));
  pass(world.concepts.length > 0, `${world.concepts.length} concepts`);

  const segmentIds = new Set(world.segments.map((segment) => segment.segment_id));
  const personaIds = new Set(personas.map((persona) => persona.segmentId));
  const shareSum = world.segments.reduce((sum, segment) => sum + segment.share, 0);
  pass(world.segments.length >= 2, `${world.segments.length} segments (need 2)`);
  pass(Math.abs(shareSum - 1) < SHARE_TOLERANCE, `segment shares sum to ${shareSum.toFixed(9)}`);
  const orphans = world.segments.filter((segment) => !personaIds.has(segment.segment_id)).map((segment) => segment.segment_id);
  pass(orphans.length === 0, `every segment maps to a live persona fact${orphans.length ? ` (not: ${orphans.join(', ')})` : ''}`);
  const missing = [...personaIds].filter((id) => !segmentIds.has(id));
  pass(missing.length === 0, `every live persona has a segment${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  for (const segment of world.segments) {
    const quotes = json<string[]>(segment.quotes, []);
    pass(quotes.length >= 2, `${segment.segment_id}: ${quotes.length} quotes (reducer needs 2)`);
    if (quotes.length >= 2) pass(quotes.length >= QUOTES_WANTED, `${segment.segment_id}: ${quotes.length} quotes (contract wants ${QUOTES_WANTED}-20)`, 'WARN');
    const weights = Object.keys(json<Record<string, number>>(segment.prior_weights, {}));
    const unknown = weights.filter((key) => !conceptKeys.has(key));
    pass(unknown.length === 0, `${segment.segment_id}: prior_weights keys are concepts${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);
    const unheld = [...conceptKeys].filter((key) => !weights.includes(key));
    if (unheld.length) pass(false, `${segment.segment_id}: no prior for ${unheld.join(', ')}`, 'WARN');
  }

  const allowed = new Set<string>(allowedHooks(hints));
  const controls = world.arms.filter((arm) => arm.strategy === 'control');
  const recipes = world.arms.filter((arm) => arm.strategy !== 'control');
  pass(controls.length === 1 && controls[0].arm_id === CONTROL_ARM_ID, `exactly one control arm, ${CONTROL_ARM_ID} (${controls.map((arm) => arm.arm_id).join(', ') || 'none'})`);
  pass(recipes.length >= 10 && recipes.length <= 12, `${recipes.length} recipes (need 10-12)`);
  const badAngles = recipes.filter((arm) => !ANGLES.includes(arm.angle)).map((arm) => arm.arm_id);
  pass(badAngles.length === 0, `every recipe angle is a food token${badAngles.length ? ` (not: ${badAngles.join(', ')})` : ''}`);
  const badHooks = recipes.filter((arm) => !allowed.has(arm.hook)).map((arm) => arm.arm_id);
  pass(badHooks.length === 0, `every recipe hook is producible and backed${badHooks.length ? ` (not: ${badHooks.join(', ')})` : ''}`);
  const pairs = recipes.map((arm) => `${arm.angle}|${arm.hook}`);
  pass(new Set(pairs).size === pairs.length, 'every (angle, hook) pair is unique');

  const creativeIds = new Set(world.creatives.map((creative) => creative.creative_id));
  const danglingEvidence = world.arms.flatMap((arm) =>
    json<string[]>(arm.evidence, [])
      .filter((id) => id.startsWith('cr_') && !creativeIds.has(id))
      .map((id) => `${arm.arm_id} → ${id}`),
  );
  pass(danglingEvidence.length === 0, `every cr_ evidence id is a creative${danglingEvidence.length ? ` (missing: ${danglingEvidence.slice(0, 5).join(', ')}${danglingEvidence.length > 5 ? ', …' : ''})` : ''}`);

  const brandLive = world.creatives.filter((creative) => creative.origin === 'brand_live');
  pass(brandLive.some((creative) => creative.arm_id === CONTROL_ARM_ID && creative.status === 'ranked'), `the control arm has ranked brand_live creatives (${brandLive.length})`);
  const offControl = brandLive.filter((creative) => creative.arm_id !== CONTROL_ARM_ID || creative.brand_id !== clientId).length;
  pass(offControl === 0, `brand_live creatives are the client's and sit in ${CONTROL_ARM_ID}${offControl ? ` (${offControl} don't)` : ''}`);
  const competitorLive = world.creatives.filter((creative) => creative.origin === 'competitor_live');
  pass(competitorLive.length > 0, `${competitorLive.length} competitor_live creatives`);
  const brandIds = new Set(world.brands.map((brand) => brand.brand_id));
  const unknownBrand = world.creatives.filter((creative) => !brandIds.has(creative.brand_id)).length;
  pass(unknownBrand === 0, `every creative's brand exists${unknownBrand ? ` (${unknownBrand} don't)` : ''}`);

  // B owns product. Its engine throws when the ad it picks has no landing product.
  const productIds = new Set(world.products.map((product) => product.product_id));
  const noProduct = [...new Set(world.creatives.filter((creative) => creative.brand_id === clientId && !productIds.has(creative.landing_product_id)).map((creative) => creative.landing_product_id || '""'))];
  pass(noProduct.length === 0, `the client's creatives land on a product in B's product table${noProduct.length ? ` (not yet: ${noProduct.join(', ')}; B writes products)` : ''}`, 'WARN');
  const strayProducts = world.products.filter((product) => !brandIds.has(product.brand_id)).map((product) => product.product_id);
  if (strayProducts.length) pass(false, `B's products with a brand A4 doesn't write (checkWorld rejects them): ${strayProducts.join(', ')}`, 'WARN');

  const skips: string[] = [];
  for (const arm of recipes) {
    if (hookRequirement(arm.hook) !== 'customer_verbatim') continue;
    for (const persona of personas) {
      if (!persona.hasVerbatims) skips.push(`${arm.arm_id} × ${persona.segmentId}: ${arm.hook} needs customer_verbatim; the segment's persona has no verbatims`);
    }
  }

  return { lines, skips, failed: lines.some((line) => line.level === 'FAIL') };
}

export function printCheck(title: string, result: CheckResult): void {
  console.log(`\n${title}`);
  for (const line of result.lines) console.log(`${line.level.padEnd(4)}  ${line.text}`);
  if (result.skips.length) {
    console.log('\n(recipe, segment) pairs A5 skips by design');
    for (const skip of result.skips) console.log(`  ${skip}`);
  }
}

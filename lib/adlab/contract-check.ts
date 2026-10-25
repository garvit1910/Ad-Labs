import type { StrategyPackHints } from '@/lib/creative-engine/generation/strategy';
import { producibleHookAllowlist } from '@/lib/creative-engine/generation/strategy';
import { CONTROL_ARM_ID, FOOD_ANGLES, RECIPE_HOOKS } from './contract';

/*
 * The rules no single reducer can check (reducers_a.ts header): whole-table counts,
 * shares, evidence, landing products, and the word budget B's renderer enforces.
 * One pure check, used by A4 before and after it writes (npm run a4:rows -- check)
 * and by A5 before round 0 and every task (npm run a5:creatives -- check). It covers
 * B's checkWorld errors on A's tables, so a PASS here means B's loader accepts them.
 */

export interface ContractWorld {
  brands: Array<{ brand_id: string; name: string; is_client: boolean }>;
  concepts: Array<{ key: string; label: string }>;
  segments: Array<{ segment_id: string; name: string; description: string; share: number; prior_weights: string; quotes: string }>;
  arms: Array<{ arm_id: string; angle: string; hook: string; strategy: string; evidence: string }>;
  creatives: Array<{
    creative_id: string;
    arm_id: string;
    brand_id: string;
    origin: string;
    headline: string;
    primary_text: string;
    cta: string;
    visual_description: string;
    landing_product_id: string;
    status: string;
  }>;
  products: Array<{ product_id: string; brand_id: string; name: string }>;
}

/** One live persona fact, as the segment it should become. */
export interface PersonaInfo {
  segmentId: string;
  hasVerbatims: boolean;
}

export type CheckLevel = 'PASS' | 'WARN' | 'FAIL';

export interface ContractCheck {
  lines: Array<{ level: CheckLevel; text: string }>;
  failed: boolean;
  /** The worst-case Jev state A's rows can produce, in words (B throws at 450). */
  worstStateWords: number;
}

const EXPECTED_BRANDS = 8;
const QUOTES_WANTED = 8;
const SHARE_TOLERANCE = 1e-6;
/** B's render.maxWords: a state of 450 words or more throws and fails the round. */
export const STATE_WORD_LIMIT = 450;
const STATE_WORD_WARN = 420;

const json = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const longest = (values: number[], n: number) => [...values].sort((a, b) => b - a).slice(0, n);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Words in B's `renderAd`: "<brand>: <headline> <primary_text> [Button: <cta>] [Image: <visual>]". */
export function adWords(creative: ContractWorld['creatives'][number], brandName: string): number {
  const image = creative.visual_description ? 1 + words(creative.visual_description) : 0;
  return words(brandName) + words(creative.headline) + words(creative.primary_text) + 1 + words(creative.cta) + image;
}

/**
 * A pessimistic word count of the longest state B can render from these rows
 * (sim/src/render.ts renderFeedState / renderPageState): the longest description and
 * two longest quotes of any segment, a six-concept preference line of the longest
 * labels, a memory that has seen every competitor this week, our longest ranked ad
 * and the two longest competitor ads. If this stays under 450, B can't throw.
 */
export function worstStateWords(world: ContractWorld): number {
  const client = world.brands.find((brand) => brand.is_client);
  if (!client) return 0;
  const brandName = new Map(world.brands.map((brand) => [brand.brand_id, brand.name]));
  const labels = world.concepts.filter((concept) => concept.key !== 'other').map((concept) => words(concept.label));
  // "Cares a lot about: … Cares somewhat about: … Doesn't think about: …", six labels, three "and"s.
  const preference = sum(longest(labels, 6)) + 10 + 3;
  const market = 15; // "Shopping for a new cereal right now and wants to buy within a few days."
  const longestLabel = Math.max(0, ...labels);
  const competitors = [...new Set(world.creatives.filter((c) => c.origin === 'competitor_live').map((c) => c.brand_id))];
  const clientProducts = world.products.filter((product) => product.brand_id === client.brand_id);
  const memory =
    1 +
    (8 + words(client.name) + longestLabel) + // "Has seen <client> ads three times this week, mostly about <label>."
    sum(competitors.map((id) => 7 + words(brandName.get(id) ?? id))) + // "Has also seen <brand> ads twice this week."
    (6 + words(client.name)) + // "Opinion of <client>: skeptical, from three page visits."
    (12 + words(client.name)) + // "Tapped a <client> ad two days ago, looked at the page, didn't buy."
    sum(clientProducts.map((product) => 5 + words(product.name))); // "Thinks the <product> costs about $39."
  const ours = world.creatives
    .filter((c) => c.brand_id === client.brand_id && c.arm_id && c.status === 'ranked')
    .map((c) => adWords(c, client.name));
  const theirs = world.creatives
    .filter((c) => c.origin === 'competitor_live' && c.status === 'ranked')
    .map((c) => adWords(c, brandName.get(c.brand_id) ?? c.brand_id));
  const ourAd = Math.max(0, ...ours);
  const feed = 2 + 11 + 3 + ourAd + sum(longest(theirs, 2)); // "RIGHT NOW", the scrolling line, three "- " posts
  const page = 2 + ourAd + 2 + 9 + 14 + 9; // THEY TAPPED, THE PAGE, price, rating + highlights, comparison
  let worst = 0;
  for (const segment of world.segments) {
    const quotes = json<string[]>(segment.quotes, []).map(words);
    const shopper = 1 + 2 + words(segment.description) + 4 + sum(longest(quotes, 2)) + 1 + preference + market;
    worst = Math.max(worst, shopper + memory + Math.max(feed, page));
  }
  return worst;
}

export function checkContract(world: ContractWorld, personas: PersonaInfo[], hints?: StrategyPackHints): ContractCheck {
  const lines: ContractCheck['lines'] = [];
  const pass = (ok: boolean, text: string, level: 'FAIL' | 'WARN' = 'FAIL') => lines.push({ level: ok ? 'PASS' : level, text });

  const clients = world.brands.filter((brand) => brand.is_client);
  pass(clients.length === 1, `exactly one client brand (${clients.map((brand) => brand.brand_id).join(', ') || 'none'})`);
  pass(world.brands.length === EXPECTED_BRANDS, `${world.brands.length} brands (Magic Spoon and the seven competitors: ${EXPECTED_BRANDS})`, 'WARN');
  const clientId = clients[0]?.brand_id ?? '';
  const brandIds = new Set(world.brands.map((brand) => brand.brand_id));

  const conceptKeys = new Set(world.concepts.map((concept) => concept.key));
  pass(world.concepts.length > 0, `${world.concepts.length} concepts`);

  const segmentIds = new Set(world.segments.map((segment) => segment.segment_id));
  const personaIds = new Set(personas.map((persona) => persona.segmentId));
  const shareSum = world.segments.reduce((total, segment) => total + segment.share, 0);
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

  const controls = world.arms.filter((arm) => arm.strategy === 'control');
  const recipes = world.arms.filter((arm) => arm.strategy !== 'control');
  pass(controls.length === 1 && controls[0].arm_id === CONTROL_ARM_ID, `exactly one control arm, ${CONTROL_ARM_ID} (${controls.map((arm) => arm.arm_id).join(', ') || 'none'})`);
  pass(recipes.length >= 10 && recipes.length <= 12, `${recipes.length} recipes (need 10-12)`);
  const badAngles = recipes.filter((arm) => !FOOD_ANGLES.includes(arm.angle)).map((arm) => arm.arm_id);
  pass(badAngles.length === 0, `every recipe angle is a food token${badAngles.length ? ` (not: ${badAngles.join(', ')})` : ''}`);
  const hooks = new Set<string>(RECIPE_HOOKS);
  const badHooks = recipes.filter((arm) => !hooks.has(arm.hook)).map((arm) => arm.arm_id);
  pass(badHooks.length === 0, `every recipe hook is one the copywriter can produce${badHooks.length ? ` (not: ${badHooks.join(', ')})` : ''}`);
  if (hints) {
    const backed = new Set<string>(producibleHookAllowlist(hints));
    const unbacked = recipes.filter((arm) => hooks.has(arm.hook) && !backed.has(arm.hook)).map((arm) => arm.arm_id);
    pass(unbacked.length === 0, `every recipe hook's fact requirement is met by the brand facts${unbacked.length ? ` (not: ${unbacked.join(', ')})` : ''}`);
  }
  const pairs = recipes.map((arm) => `${arm.angle}|${arm.hook}`);
  pass(new Set(pairs).size === pairs.length, 'every (angle, hook) pair is unique');
  const badEvidence = world.arms.filter((arm) => {
    const evidence = json<unknown>(arm.evidence, null);
    return !Array.isArray(evidence) || !evidence.every((id) => typeof id === 'string');
  });
  pass(badEvidence.length === 0, `every arm's evidence is a JSON list of ids${badEvidence.length ? ` (not: ${badEvidence.map((arm) => arm.arm_id).join(', ')})` : ''}`);
  const creativeIds = new Set(world.creatives.map((creative) => creative.creative_id));
  const danglingEvidence = world.arms.flatMap((arm) =>
    json<unknown[]>(arm.evidence, [])
      .filter((id): id is string => typeof id === 'string' && id.startsWith('cr_') && !creativeIds.has(id))
      .map((id) => `${arm.arm_id} → ${id}`),
  );
  pass(danglingEvidence.length === 0, `every cr_ evidence id is a creative${danglingEvidence.length ? ` (missing: ${danglingEvidence.slice(0, 5).join(', ')}${danglingEvidence.length > 5 ? ', …' : ''})` : ''}`);

  const brandLive = world.creatives.filter((creative) => creative.origin === 'brand_live');
  pass(brandLive.some((creative) => creative.arm_id === CONTROL_ARM_ID && creative.status === 'ranked'), `the control arm has ranked brand_live creatives (${brandLive.length})`);
  const offControl = brandLive.filter((creative) => creative.arm_id !== CONTROL_ARM_ID || creative.brand_id !== clientId).length;
  pass(offControl === 0, `brand_live creatives are the client's and sit in ${CONTROL_ARM_ID}${offControl ? ` (${offControl} don't)` : ''}`);
  const competitorLive = world.creatives.filter((creative) => creative.origin === 'competitor_live');
  pass(competitorLive.length > 0, `${competitorLive.length} competitor_live creatives`);
  const unknownBrand = world.creatives.filter((creative) => !brandIds.has(creative.brand_id)).length;
  pass(unknownBrand === 0, `every creative's brand exists${unknownBrand ? ` (${unknownBrand} don't)` : ''}`);

  // B owns product. B's loader rejects a creative landing on a missing or foreign product, and its
  // engine throws on an impression of a client ad with no landing product, so both are FAILs.
  const clientProducts = world.products.filter((product) => clientId && product.brand_id === clientId).length;
  pass(clientProducts > 0, `B has written a product for the client (${clientProducts}${clientId ? ` for ${clientId}` : ', no client brand yet'})`);
  const productBrand = new Map(world.products.map((product) => [product.product_id, product.brand_id]));
  const badLanding = [
    ...new Set(
      world.creatives
        .filter((creative) => creative.brand_id === clientId && productBrand.get(creative.landing_product_id) !== clientId)
        .map((creative) => creative.landing_product_id || '""'),
    ),
  ];
  pass(badLanding.length === 0, `every client creative lands on a client product in B's product table${badLanding.length ? ` (not yet: ${badLanding.join(', ')}; B writes products)` : ''}`);
  const strayProducts = world.products.filter((product) => !brandIds.has(product.brand_id)).map((product) => product.product_id);
  pass(strayProducts.length === 0, `every product's brand exists${strayProducts.length ? ` (B's loader rejects: ${strayProducts.join(', ')})` : ''}`);

  const worst = worstStateWords(world);
  const budget = `worst-case Jev state is ${worst} words (B throws at ${STATE_WORD_LIMIT})`;
  if (worst >= STATE_WORD_LIMIT) pass(false, budget);
  else pass(worst < STATE_WORD_WARN, budget, 'WARN');

  return { lines, failed: lines.some((line) => line.level === 'FAIL'), worstStateWords: worst };
}

export function printContractCheck(title: string, result: ContractCheck): void {
  console.log(`\n${title}`);
  for (const line of result.lines) console.log(`${line.level.padEnd(4)}  ${line.text}`);
}

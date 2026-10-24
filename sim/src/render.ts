import { config } from "./config.js";
import type { Creative, Product } from "./contract.js";
import type { World } from "./fixtures.js";
import type { Shopper } from "./population.js";

// Turns a shopper into the text Jev reads ("The Jev calls" > "The state text"), following
// the rendering rules: every fact once, no segment name, numbers as words, no budget,
// literal abstention lines.

const CARES_A_LOT = 0.7;
const CARES_SOMEWHAT = 0.45;
const LIKES = 0.6;
const MIXED = 0.45;
const WEEK_TICKS = 7;
// Slots in the preference line that always go to the shopper's strongest concepts, so
// claimed concepts can't crowd out who the shopper is.
const STRONGEST_RESERVED = 3;
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function timesWord(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function countWord(n: number, one: string, many: string): string {
  if (n === 1) return one === "purchase" ? "a purchase" : `one ${one}`;
  return `${NUMBER_WORDS[n] ?? n} ${many}`;
}

function daysAgo(days: number): string {
  return days <= 0 ? "earlier today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

// At most maxConcepts concepts: the strongest few, then concepts today's ads claim (in the
// order given), then more of the strongest.
export function preferenceLine(shopper: Shopper, world: World, claimedConcepts: readonly string[] = []): string {
  const label = new Map(world.concepts.map((c) => [c.key, c.label]));
  const max = config.render.maxConcepts;
  const strongest = Object.entries(shopper.preferences)
    .filter(([k]) => k !== "other")
    .sort(([, a], [, b]) => b.w - a.w)
    .map(([k]) => k);
  const shown = new Set<string>(strongest.slice(0, Math.min(STRONGEST_RESERVED, max)));
  for (const k of claimedConcepts) {
    if (shown.size >= max) break;
    if (k !== "other" && shopper.preferences[k]) shown.add(k);
  }
  for (const k of strongest) {
    if (shown.size >= max) break;
    shown.add(k);
  }
  const ordered = [...shown].sort((a, b) => shopper.preferences[b]!.w - shopper.preferences[a]!.w);
  const bucket = (pred: (w: number) => boolean) =>
    ordered.filter((k) => pred(shopper.preferences[k]!.w)).map((k) => label.get(k) ?? k);
  const parts = [
    ["Cares a lot about", bucket((w) => w >= CARES_A_LOT)],
    ["Cares somewhat about", bucket((w) => w >= CARES_SOMEWHAT && w < CARES_A_LOT)],
    ["Doesn't think about", bucket((w) => w < CARES_SOMEWHAT)],
  ] as const;
  return parts
    .filter(([, labels]) => labels.length > 0)
    .map(([head, labels]) => `${head}: ${joinLabels(labels)}.`)
    .join(" ");
}

function opinionWords(value: number): string {
  return value >= LIKES ? "likes it" : value >= MIXED ? "mixed" : "skeptical";
}

export function memoryLines(shopper: Shopper, world: World, tick: number): string[] {
  const client = world.brands.find((b) => b.is_client)!;
  const brandName = new Map(world.brands.map((b) => [b.brand_id, b.name]));
  const label = new Map(world.concepts.map((c) => [c.key, c.label]));
  const thisWeek = shopper.exposures.filter((e) => e.tick > tick - WEEK_TICKS);
  const lines: string[] = [];

  const ours = thisWeek.filter((e) => e.brand_id === client.brand_id);
  if (ours.length === 0) {
    lines.push(
      shopper.exposures.some((e) => e.brand_id === client.brand_id)
        ? `Hasn't seen a ${client.name} ad this week.`
        : `Has never seen a ${client.name} ad.`,
    );
  } else {
    const counts = new Map<string, number>();
    for (const e of ours) for (const k of e.concepts) if (k !== "other") counts.set(k, (counts.get(k) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const about = top ? `, mostly about ${label.get(top) ?? top}` : "";
    lines.push(`Has seen ${client.name} ads ${timesWord(ours.length)} this week${about}.`);
  }

  const competitorCounts = new Map<string, number>();
  for (const e of thisWeek) {
    if (e.brand_id !== client.brand_id) competitorCounts.set(e.brand_id, (competitorCounts.get(e.brand_id) ?? 0) + 1);
  }
  for (const [brandId, n] of competitorCounts) {
    lines.push(`Has also seen ${brandName.get(brandId) ?? brandId} ads ${timesWord(n)} this week.`);
  }

  const opinion = shopper.opinions[client.brand_id];
  if (opinion) {
    const source =
      opinion.purchases > 0
        ? countWord(opinion.purchases, "purchase", "purchases")
        : countWord(opinion.page_visits, "page visit", "page visits");
    lines.push(`Opinion of ${client.name}: ${opinionWords(opinion.value)}, from ${source}.`);
  } else {
    lines.push(`No opinion of ${client.name} yet.`);
  }

  const engagement = lastEngagementLine(shopper, world, client.brand_id, client.name, tick);
  if (engagement) lines.push(engagement);

  for (const p of world.products) {
    const expected = shopper.expected_price_usd[p.product_id];
    if (p.brand_id === client.brand_id && expected !== undefined) {
      lines.push(`Thinks the ${p.name} costs about $${Math.round(expected)}.`);
    }
  }
  return lines;
}

// "Tapped a Magic Spoon ad 2 days ago, looked at the page, didn't buy." for the most recent
// tap on one of our ads; stay and buy on the same tick and creative belong to that visit.
function lastEngagementLine(shopper: Shopper, world: World, clientId: string, clientName: string, tick: number): string | null {
  const ourCreatives = new Set(world.creatives.filter((c) => c.brand_id === clientId).map((c) => c.creative_id));
  const taps = shopper.engagements.filter((e) => e.kind === "tap" && ourCreatives.has(e.creative_id));
  const last = taps.reduce<(typeof taps)[number] | undefined>((a, e) => (!a || e.tick >= a.tick ? e : a), undefined);
  if (!last) return null;
  const visit = shopper.engagements.filter((e) => e.tick === last.tick && e.creative_id === last.creative_id);
  const stayed = visit.some((e) => e.kind === "stay");
  const bought = visit.some((e) => e.kind === "buy");
  const outcome = bought ? "looked at the page and bought" : stayed ? "looked at the page, didn't buy" : "left the page right away";
  return `Tapped a ${clientName} ad ${daysAgo(tick - last.tick)}, ${outcome}.`;
}

export function renderShopper(shopper: Shopper, world: World, claimedConcepts: readonly string[] = []): string {
  const segment = world.segments.find((s) => s.segment_id === shopper.segment_id)!;
  const name = shopper.display_name.endsWith(".") ? shopper.display_name : `${shopper.display_name}.`;
  return [
    "SHOPPER",
    `${name} ${segment.description}`,
    `In their own words: ${shopper.quotes.map((q) => `"${q}"`).join(" / ")}`,
    preferenceLine(shopper, world, claimedConcepts),
    shopper.in_market
      ? "Shopping for a new cereal right now and wants to buy within a few days."
      : "Not shopping for cereal right now.",
  ].join("\n");
}

// The feed's three posts are listed in the state, in feed order (B1: one Noul per ad).
export function renderFeedState(
  shopper: Shopper,
  world: World,
  tick: number,
  ads: readonly Creative[],
  claimedConcepts: readonly string[] = [],
): string {
  const state = [
    renderShopper(shopper, world, claimedConcepts),
    ["MEMORY", ...memoryLines(shopper, world, tick)].join("\n"),
    [
      "RIGHT NOW",
      "Scrolling Instagram on their phone. Three sponsored posts appear one after another:",
      ...ads.map((c) => `- ${renderAd(c, world)}`),
    ].join("\n"),
  ].join("\n\n");
  return checkLength(state, shopper);
}

function checkLength(state: string, shopper: Shopper): string {
  const words = wordCount(state);
  if (words > config.render.maxWords) {
    throw new Error(`state for ${shopper.shopper_id} is ${words} words, limit ${config.render.maxWords}`);
  }
  return state;
}

// Within this relative gap a price reads as "about what they expected".
const PRICE_SAME = 0.1;

// Rule 3: the price gap arrives pre-computed, in words, rounded to the nearest 10%.
export function priceComparison(expectedUsd: number | undefined, priceUsd: number): string {
  if (expectedUsd === undefined) return "first time seeing a price";
  const gap = (priceUsd - expectedUsd) / expectedUsd;
  if (gap <= -PRICE_SAME) return "cheaper than expected";
  if (gap < PRICE_SAME) return "about what they expected";
  return `about ${Math.round(gap * 10) * 10}% more than expected`;
}

function usd(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

// The page call's state: SHOPPER and MEMORY, then THEY TAPPED (the exact ad, so its promise is
// checked against its own landing page) and THE PAGE. The price always shows, so the first
// visit reacts to it (ShopSim bug (a)).
export function renderPageState(
  shopper: Shopper,
  world: World,
  tick: number,
  ad: Creative,
  product: Product,
  claimedConcepts: readonly string[] = [],
): string {
  const subscription =
    product.subscription_price_usd === null ? "" : `, ${usd(product.subscription_price_usd)} with subscription`;
  const rating =
    product.review_count > 0
      ? `Rated ${product.rating} from ${product.review_count.toLocaleString("en-US")} reviews.`
      : "No reviews shown.";
  const highlights = product.page_highlights.length ? ` Page highlights: ${product.page_highlights.join(", ")}.` : "";
  const shipping = product.shipping_note ? ` ${product.shipping_note}` : "";
  const state = [
    renderShopper(shopper, world, claimedConcepts),
    ["MEMORY", ...memoryLines(shopper, world, tick)].join("\n"),
    ["THEY TAPPED", renderAd(ad, world)].join("\n"),
    [
      "THE PAGE",
      `${product.name} — ${usd(product.price_usd)} one-time${subscription}.`,
      `${rating}${highlights}${shipping}`,
      `Price compared with what they expected: ${priceComparison(shopper.expected_price_usd[product.product_id], product.price_usd)}.`,
    ].join("\n"),
  ].join("\n\n");
  return checkLength(state, shopper);
}

export function renderAd(creative: Creative, world: World): string {
  const brand = world.brands.find((b) => b.brand_id === creative.brand_id)?.name ?? creative.brand_id;
  const image = creative.visual_description ? ` [Image: ${creative.visual_description}]` : "";
  const headline = /[.!?"”]$/.test(creative.headline) ? creative.headline : `${creative.headline}.`;
  return `${brand}: ${headline} ${creative.primary_text} [Button: ${creative.cta}]${image}`;
}

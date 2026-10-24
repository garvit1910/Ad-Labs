import { config } from "./config.js";
import type { Creative } from "./contract.js";
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

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function timesWord(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

// At most maxConcepts concepts: any concept today's ads claim, then the strongest others.
export function preferenceLine(shopper: Shopper, world: World, claimedConcepts: readonly string[] = []): string {
  const label = new Map(world.concepts.map((c) => [c.key, c.label]));
  const shown = new Set<string>();
  for (const k of claimedConcepts) if (k !== "other" && shopper.preferences[k]) shown.add(k);
  const strongest = Object.entries(shopper.preferences)
    .filter(([k]) => k !== "other" && !shown.has(k))
    .sort(([, a], [, b]) => b.w - a.w);
  for (const [k] of strongest) {
    if (shown.size >= config.render.maxConcepts) break;
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
    for (const e of ours) for (const k of e.concepts) counts.set(k, (counts.get(k) ?? 0) + 1);
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
  lines.push(
    opinion
      ? `Opinion of ${client.name}: ${opinionWords(opinion.value)}, from ${opinion.source === "purchase" ? "a purchase" : "a page visit"}.`
      : `No opinion of ${client.name} yet.`,
  );
  return lines;
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

export function renderFeedState(
  shopper: Shopper,
  world: World,
  tick: number,
  claimedConcepts: readonly string[] = [],
): string {
  return [
    renderShopper(shopper, world, claimedConcepts),
    ["MEMORY", ...memoryLines(shopper, world, tick)].join("\n"),
    ["RIGHT NOW", "Scrolling Instagram on their phone. Three sponsored posts appear one after another."].join("\n"),
  ].join("\n\n");
}

export function renderAd(creative: Creative, world: World): string {
  const brand = world.brands.find((b) => b.brand_id === creative.brand_id)?.name ?? creative.brand_id;
  const image = creative.visual_description ? ` [Image: ${creative.visual_description}]` : "";
  const headline = /[.!?"”]$/.test(creative.headline) ? creative.headline : `${creative.headline}.`;
  return `${brand}: ${headline} ${creative.primary_text} [Button: ${creative.cta}]${image}`;
}

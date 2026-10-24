import { config } from "./config.js";
import type { Segment } from "./contract.js";
import type { World } from "./fixtures.js";
import { bernoulli, normal, shuffle, weightedIndex } from "./rng.js";

export type Preference = { w: number; E: number };
// Counts drive the "from one page visit" / "from a purchase" wording.
export type Opinion = { value: number; E: number; page_visits: number; purchases: number };
export type Exposure = { tick: number; creative_id: string; brand_id: string; concepts: string[] };
export type Engagement = { tick: number; creative_id: string; kind: "tap" | "stay" | "buy" };

export type Shopper = {
  shopper_id: string;
  index: number;
  segment_id: string;
  display_name: string;
  quotes: string[];
  preferences: Record<string, Preference>;
  // brand_id -> opinion; absent means no opinion yet (abstention, never a fake neutral).
  opinions: Record<string, Opinion>;
  exposures: Exposure[];
  engagements: Engagement[];
  in_market: boolean;
  in_market_until_tick: number | null;
  budget_left_usd: number;
  // product_id -> expected price
  expected_price_usd: Record<string, number>;
};

const NAMES = [
  "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Rowan",
  "Sam", "Drew", "Parker", "Reese", "Skyler", "Cameron", "Dana", "Emerson", "Finley", "Hayden",
  "Kendall", "Logan", "Marley", "Noel", "Peyton", "Robin", "Sage", "Shawn", "Tatum", "Blake",
  "Charlie", "Devon", "Elliot", "Frankie", "Harper", "Jesse", "Kai", "Lane", "Micah", "Oakley",
];
const INITIALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const SHOPPING_FLAG_TICKS = 4;

export function shopperId(index: number): string {
  return `shp_${String(index + 1).padStart(4, "0")}`;
}

export function displayName(index: number): string {
  const first = NAMES[index % NAMES.length]!;
  const initial = INITIALS[Math.floor(index / NAMES.length) % INITIALS.length]!;
  return `${first} ${initial}.`;
}

function clip(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// One shopper, drawn only from keys that include its own index.
export function makeShopper(index: number, world: World, seed: number): Shopper {
  const id = shopperId(index);
  const segIdx = weightedIndex(world.segments.map((s) => s.share), seed, "population", id, "segment");
  const segment: Segment = world.segments[segIdx]!;
  const c = config.shopper;

  const preferences: Record<string, Preference> = {};
  for (const { key } of world.concepts) {
    const prior = segment.prior_weights[key];
    if (prior === undefined) {
      // No prior for this concept: an unheld concept (ShopSim's Phase 7 fix).
      preferences[key] = { w: c.unheldW, E: c.unheldE };
      continue;
    }
    const w = clip(normal(prior, c.preferenceSd, seed, "population", id, "pref", key), c.preferenceMin, c.preferenceMax);
    preferences[key] = { w, E: c.preferenceEvidence };
  }

  // Its own key: the "need" stream is for per-tick arrivals in the sim day.
  const inMarket = bernoulli(segment.in_market_rate, seed, "population", id, "in_market");
  return {
    shopper_id: id,
    index,
    segment_id: segment.segment_id,
    display_name: displayName(index),
    quotes: shuffle(segment.quotes, seed, "population", id, "quotes").slice(0, c.quotesShown),
    preferences,
    opinions: {},
    exposures: [],
    engagements: [],
    in_market: inMarket,
    in_market_until_tick: inMarket ? SHOPPING_FLAG_TICKS - 1 : null,
    budget_left_usd: Math.max(
      c.budgetFloorUsd,
      normal(segment.budget_mean_usd, segment.budget_sd_usd, seed, "population", id, "budget"),
    ),
    expected_price_usd: {},
  };
}

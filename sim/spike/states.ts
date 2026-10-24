import type { Creative } from "../src/contract.js";
import type { World } from "../src/fixtures.js";
import type { Exposure, Shopper } from "../src/population.js";
import { displayName } from "../src/population.js";
import { renderAd, renderShopper, memoryLines } from "../src/render.js";

// Hand-built shoppers: preferences are the segment's priors exactly (no draw noise), so each
// state is the segment's typical member and the tests read cleanly. They still go through the
// real renderer, so the spike measures the text the engine will send.

export type SpikeState = { id: string; note: string; shopper: Shopper; tick: number };

export function handShopper(world: World, segmentId: string, index: number, opts: { inMarket: boolean }): Shopper {
  const seg = world.segments.find((s) => s.segment_id === segmentId);
  if (!seg) throw new Error(`no segment ${segmentId}`);
  const preferences: Shopper["preferences"] = {};
  for (const { key } of world.concepts) preferences[key] = { w: seg.prior_weights[key] ?? 0.5, E: 2 };
  return {
    shopper_id: `shp_spike_${index}`,
    index,
    segment_id: segmentId,
    display_name: displayName(index),
    quotes: seg.quotes.slice(0, 2),
    preferences,
    opinions: {},
    exposures: [],
    engagements: [],
    in_market: opts.inMarket,
    in_market_until_tick: opts.inMarket ? 3 : null,
    budget_left_usd: seg.budget_mean_usd,
    expected_price_usd: {},
  };
}

// "Seen 4 protein ads this week": four Magic Spoon protein exposures in the last 7 ticks.
export function withProteinExposures(s: Shopper): Shopper {
  const exposures: Exposure[] = [1, 2, 3, 4].map((tick) => ({
    tick,
    creative_id: tick % 2 ? "cr_gen_03" : "cr_gen_07",
    brand_id: "br_magic_spoon",
    concepts: ["high_protein"],
  }));
  return { ...s, shopper_id: `${s.shopper_id}_mem`, exposures };
}

export const MEMORY_TICK = 5;

export function buildStates(world: World): {
  base: SpikeState[];
  memory: { without: SpikeState; with: SpikeState }[];
} {
  const base: SpikeState[] = [];
  world.segments.forEach((seg, i) => {
    for (const inMarket of [false, true]) {
      const shopper = handShopper(world, seg.segment_id, i * 2 + (inMarket ? 1 : 0), { inMarket });
      base.push({ id: `${seg.segment_id}${inMarket ? "+need" : ""}`, note: `${seg.name}, ${inMarket ? "shopping now" : "not shopping"}`, shopper, tick: 0 });
    }
  });
  const pick = (id: string) => base.find((s) => s.id === id)!;
  const memory = ["seg_protein_athlete", "seg_protein_athlete+need", "seg_keto_low_carb"].map((id) => {
    const b = pick(id);
    // Same shopper rendered at the same tick, with and without the four exposures.
    return {
      without: { ...b, tick: MEMORY_TICK },
      with: { id: `${id}+4protein`, note: `${b.note}, seen 4 protein ads`, shopper: withProteinExposures(b.shopper), tick: MEMORY_TICK },
    };
  });
  return { base, memory };
}

// SPIKE-ONLY page values. The real prices aren't in products.json yet; these only need to be
// plausible and identical across the need on/off pairs, because test 4 is directional.
export const SPIKE_PAGE = {
  price_usd: 47,
  subscription_price_usd: 40,
  rating: 4.5,
  review_count: "5,000",
  highlights: ["high protein", "zero sugar", "four flavors"],
  shipping_note: "Free shipping on orders over $35.",
};

// The page call's state ("The Jev calls"): SHOPPER and MEMORY, then THEY TAPPED and THE PAGE.
export function renderPageState(s: SpikeState, ad: Creative, world: World): string {
  const product = world.products.find((p) => p.product_id === ad.landing_product_id)!;
  const p = SPIKE_PAGE;
  return [
    renderShopper(s.shopper, world),
    ["MEMORY", ...memoryLines(s.shopper, world, s.tick)].join("\n"),
    ["THEY TAPPED", renderAd(ad, world)].join("\n"),
    [
      "THE PAGE",
      `${product.name} — $${p.price_usd} one-time, $${p.subscription_price_usd} with subscription.`,
      `Rated ${p.rating} from ${p.review_count} reviews. Page highlights: ${p.highlights.join(", ")}. ${p.shipping_note}`,
      "Price compared with what they expected: first time seeing a price",
    ].join("\n"),
  ].join("\n\n");
}

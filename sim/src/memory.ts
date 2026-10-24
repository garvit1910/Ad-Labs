import type { Product } from "./contract.js";
import type { Opinion, Preference, Shopper } from "./population.js";
import { SHOPPING_FLAG_TICKS } from "./population.js";

// The evidence table ("Learning rules"), with ShopSim's double count fixed: a page visit is
// one STAY event and one evidence row. Seeing an ad never teaches taste; a bounce teaches
// nothing.
//
//   w' = (E·w + wt·target) / (E + wt),   E' = min(E + wt, 8)

export type EvidenceEvent = "seen" | "tap" | "stay" | "buy" | "bounce";

export const EVIDENCE: Record<EvidenceEvent, { pref: number; opinion: { wt: number; target: number } | null }> = {
  seen: { pref: 0, opinion: null },
  tap: { pref: 0.1, opinion: null },
  stay: { pref: 0.25, opinion: { wt: 0.75, target: 0.6 } },
  buy: { pref: 1.0, opinion: { wt: 1.5, target: 0.65 } },
  bounce: { pref: 0, opinion: null },
};

export const E_MAX = 8;
// Changes smaller than this are ignored (nothing is written, E included).
export const EPSILON = 0.01;
const PREFERENCE_TARGET = 1.0;
// Expected price: the first sighting sets it, later ones blend 0.7 old + 0.3 seen.
const PRICE_KEEP = 0.7;

export function blend(w: number, E: number, wt: number, target: number): { w: number; E: number } {
  return { w: (E * w + wt * target) / (E + wt), E: Math.min(E + wt, E_MAX) };
}

function updatePreference(p: Preference, wt: number): void {
  if (wt === 0) return;
  const next = blend(p.w, p.E, wt, PREFERENCE_TARGET);
  if (Math.abs(next.w - p.w) < EPSILON) return;
  p.w = next.w;
  p.E = next.E;
}

// A brand opinion starts empty, so the first event sets it outright (blend from E = 0).
function updateOpinion(o: Opinion | undefined, wt: number, target: number): Opinion {
  if (!o) return { value: target, E: wt, page_visits: 0, purchases: 0 };
  const next = blend(o.value, o.E, wt, target);
  if (Math.abs(next.w - o.value) < EPSILON) return o;
  return { ...o, value: next.w, E: next.E };
}

// One engagement event on our ad: preferences move toward 1.0 on the ad's claimed concepts,
// and STAY and BUY move the brand opinion.
export function applyEvidence(shopper: Shopper, event: EvidenceEvent, brandId: string, claimed: readonly string[]): void {
  const row = EVIDENCE[event];
  for (const k of claimed) {
    const p = shopper.preferences[k];
    if (p) updatePreference(p, row.pref);
  }
  if (row.opinion) {
    const o = updateOpinion(shopper.opinions[brandId], row.opinion.wt, row.opinion.target);
    shopper.opinions[brandId] = {
      ...o,
      page_visits: o.page_visits + (event === "stay" ? 1 : 0),
      purchases: o.purchases + (event === "buy" ? 1 : 0),
    };
  }
}

export function seePrice(shopper: Shopper, product: Product): void {
  const old = shopper.expected_price_usd[product.product_id];
  shopper.expected_price_usd[product.product_id] =
    old === undefined ? product.price_usd : PRICE_KEEP * old + (1 - PRICE_KEEP) * product.price_usd;
}

export function purchase(shopper: Shopper, priceUsd: number): void {
  shopper.budget_left_usd -= priceUsd;
  shopper.in_market = false;
  shopper.in_market_until_tick = null;
}

// Sim-day step 1: expire old shopping flags, then draw new arrivals. A flag lasts 4 ticks
// (its arrival tick plus 3).
export function updateNeed(shopper: Shopper, tick: number, arrives: boolean): void {
  if (shopper.in_market && shopper.in_market_until_tick !== null && shopper.in_market_until_tick < tick) {
    shopper.in_market = false;
    shopper.in_market_until_tick = null;
  }
  if (!shopper.in_market && arrives) {
    shopper.in_market = true;
    shopper.in_market_until_tick = tick + SHOPPING_FLAG_TICKS - 1;
  }
}

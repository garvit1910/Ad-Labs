import type { Creative } from "./contract.js";
import type { World } from "./fixtures.js";
import type { ChoiceQuestion, NoulQuestion } from "./jev.js";
import type { Shopper } from "./population.js";
import { renderAd } from "./render.js";
import { shuffle, weightedSample } from "./rng.js";

export const OPTION_KEYS = ["A", "B", "C"] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];
export type FeedOption = { key: OptionKey; creative: Creative };

// Our ad plus 2 ranked competitor ads, weighted by days_running, in a seeded order.
export function assembleFeed(shopper: Shopper, ours: Creative, world: World, seed: number, tick: number): FeedOption[] {
  const competitors = world.creatives.filter((c) => c.origin === "competitor_live" && c.status === "ranked");
  const neighbours = weightedSample(
    competitors,
    (c) => Math.max(1, c.days_running),
    OPTION_KEYS.length - 1,
    seed,
    "neighbours",
    shopper.shopper_id,
    tick,
  );
  const ordered = shuffle([ours, ...neighbours], seed, "order", shopper.shopper_id, tick);
  return ordered.map((creative, i) => ({ key: OPTION_KEYS[i]!, creative }));
}

export type FeedQuestions = { tap: ChoiceQuestion; believes: NoulQuestion };

// Questions in one call can't see each other, so "believes" carries our ad's full text
// instead of relying on the tap options.
export function feedQuestions(options: FeedOption[], ours: Creative, world: World): FeedQuestions {
  const criteria: Record<string, string> = {};
  for (const o of options) criteria[o.key] = renderAd(o.creative, world);
  criteria.none = "None of them: keeps scrolling without tapping any post.";
  const brand = world.brands.find((b) => b.brand_id === ours.brand_id)?.name ?? ours.brand_id;
  // A testimonial headline is already in quotes; don't wrap it twice.
  const headline = ours.headline.replace(/^["“](.*)["”]$/, "$1");
  return {
    tap: {
      type: "choice",
      instructions: "Which post, if any, does this shopper tap to learn more?",
      criteria,
    },
    believes: {
      type: "noul",
      instructions: `Does this shopper believe the main promise of the ${brand} post that says "${headline}"? The full post: ${renderAd(ours, world)}`,
    },
  };
}

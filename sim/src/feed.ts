import type { Creative } from "./contract.js";
import type { World } from "./fixtures.js";
import type { ChoiceQuestion, NoulAnswer, NoulQuestion } from "./jev.js";
import type { Shopper } from "./population.js";
import { shuffle, weightedSample } from "./rng.js";

// Feed slots in display order. Question names use them; the model never sees question names.
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

// "the Magic Spoon post that says "…"": how a question points at a post listed in the state.
// A testimonial headline is already in quotes; don't wrap it twice.
export function postRef(creative: Creative, world: World): string {
  const brand = world.brands.find((b) => b.brand_id === creative.brand_id)?.name ?? creative.brand_id;
  return `the ${brand} post that says "${creative.headline.replace(/^["“](.*)["”]$/, "$1")}"`;
}

export type TapKey = `tap_${OptionKey}`;
export type FeedQuestions = Record<TapKey, NoulQuestion> & { believes: NoulQuestion };

// The feed call, as settled by B1 (SPIKE.md): the three posts are listed in the state
// (renderFeedState) and each gets its own Noul. One Choice over A/B/C + none failed the order
// test, saturated near 1 and was 2-4x noisier.
export function feedQuestions(options: FeedOption[], ours: Creative, world: World): FeedQuestions {
  const taps = Object.fromEntries(
    options.map((o) => [
      `tap_${o.key}`,
      { type: "noul", instructions: `Does this shopper tap ${postRef(o.creative, world)} to learn more?` } satisfies NoulQuestion,
    ]),
  ) as Record<TapKey, NoulQuestion>;
  return {
    ...taps,
    believes: { type: "noul", instructions: `Does this shopper believe the main promise of ${postRef(ours, world)}?` },
  };
}

// The page call ("The questions"): asked for our ad on every impression, tapped or not,
// because the reward needs it. `buys` is phrased conditionally so it can share the call.
export const OBJECTIONS = {
  price: "The price is more than they want to pay.",
  taste_doubt: "They doubt it tastes good.",
  trust: "They don't trust the brand or its claims.",
  not_now: "They don't need cereal right now.",
  other_brand: "They'd rather buy another brand.",
  nothing: "Nothing is holding them back.",
};
export type Objection = keyof typeof OBJECTIONS;

export const PAGE_QUESTIONS = {
  stays: { type: "noul", instructions: "Does the shopper look through this page instead of leaving within a few seconds?" },
  buys: { type: "noul", instructions: "If they stay, do they buy on this visit?" },
  objection: { type: "choice", instructions: "What is the main thing holding them back, if anything?", criteria: OBJECTIONS },
} satisfies Record<string, NoulQuestion | ChoiceQuestion>;

// P(tap) per creative id from a feed call's answers.
export function tapProbabilities(options: FeedOption[], answers: Record<TapKey, NoulAnswer>): Record<string, number> {
  return Object.fromEntries(options.map((o) => [o.creative.creative_id, answers[`tap_${o.key}`].noul]));
}

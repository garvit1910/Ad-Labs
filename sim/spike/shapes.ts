import type { Creative } from "../src/contract.js";
import { type FeedOption, OPTION_KEYS, feedQuestions, tapProbabilities } from "../src/feed.js";
import type { World } from "../src/fixtures.js";
import type { ChoiceQuestion, JevClient } from "../src/jev.js";
import { renderAd, renderFeedState } from "../src/render.js";
import type { SpikeState } from "./states.js";

// The two feed-call shapes B1 decided between. Both return P(tap) per creative id.
//   choice: the plan's original shape. One Choice over A/B/C + none; ads live in the option
//           descriptions and the state's RIGHT NOW has no list.
//   noul:   the production shape (src/feed.ts): the posts listed in the state, one Noul per ad.
//           Built by the production functions, minus the `believes` question (questions are
//           answered independently, so it doesn't change the taps).

export type Shape = "choice" | "noul";
export type TapResult = { pTap: Record<string, number>; pNone: number | null; latencyMs: number; cacheHit: boolean };

export function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

const options = (ads: Creative[]): FeedOption[] => ads.map((creative, i) => ({ key: OPTION_KEYS[i]!, creative }));

// The plan's state text: RIGHT NOW without the post list.
function choiceState(s: SpikeState, ads: Creative[], world: World): string {
  return renderFeedState(s.shopper, world, s.tick, ads)
    .replace(/one after another:(\n- .*)+$/, "one after another.");
}

export function choiceRequest(s: SpikeState, ads: Creative[], world: World) {
  const opts = options(ads);
  const criteria: Record<string, string> = {};
  for (const o of opts) criteria[o.key] = renderAd(o.creative, world);
  criteria.none = "None of them: keeps scrolling without tapping any post.";
  const tap: ChoiceQuestion = { type: "choice", instructions: "Which post, if any, does this shopper tap to learn more?", criteria };
  return { state: choiceState(s, ads, world), questions: { tap }, options: opts };
}

export function noulRequest(s: SpikeState, ads: Creative[], world: World) {
  const opts = options(ads);
  const { believes: _believes, ...taps } = feedQuestions(opts, ads[0]!, world);
  return { state: renderFeedState(s.shopper, world, s.tick, ads), questions: taps, options: opts };
}

export async function askTap(client: JevClient, shape: Shape, s: SpikeState, ads: Creative[], world: World): Promise<TapResult> {
  if (shape === "choice") {
    const { state, questions, options: opts } = choiceRequest(s, ads, world);
    const r = await client.ask(state, questions);
    const pTap: Record<string, number> = {};
    for (const o of opts) pTap[o.creative.creative_id] = r.answers.tap.probabilities[o.key] ?? 0;
    return { pTap, pNone: r.answers.tap.probabilities.none ?? 0, latencyMs: r.latencyMs, cacheHit: r.cacheHit };
  }
  const { state, questions, options: opts } = noulRequest(s, ads, world);
  const r = await client.ask(state, questions);
  return { pTap: tapProbabilities(opts, r.answers), pNone: null, latencyMs: r.latencyMs, cacheHit: r.cacheHit };
}

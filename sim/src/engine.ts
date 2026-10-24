import { type Offsets, ZERO_OFFSETS, calibrate } from "./calibrate.js";
import { config } from "./config.js";
import type { Arm, Creative, Product, Segment } from "./contract.js";
import { type FeedOption, type Objection, PAGE_QUESTIONS, assembleFeed, feedQuestions, tapProbabilities } from "./feed.js";
import type { World } from "./fixtures.js";
import type { JevClient } from "./jev.js";
import { applyEvidence, purchase, seePrice, updateNeed } from "./memory.js";
import { type Perception, claimedConcepts } from "./perceive.js";
import { type Shopper, makeShopper } from "./population.js";
import { renderFeedState, renderPageState } from "./render.js";
import { bernoulli, shuffle, uniform } from "./rng.js";

// One sim day, step by step (docs/PLAN.md "Simulation design"), in memory. Every draw is
// keyed by (seed, stream, shopper, tick, ...) and each shopper's day touches only its own
// state, so the order shoppers finish in never changes a result.

export type Asker = Pick<JevClient, "ask">;

// Step 3: which arm a shopper sees today. B3 replaces this with the bandit.
export type ArmPolicy = (shopper: Shopper, arms: readonly Arm[], ctx: { seed: number; round: number; tick: number }) => Arm;

// Until the bandit exists every live arm is equally likely, which is also the warm-up's rule.
export const uniformPolicy: ArmPolicy = (shopper, arms, { seed, tick }) =>
  arms[Math.floor(uniform(seed, "arm", shopper.shopper_id, tick) * arms.length)]!;

// The warm-up's rule: "every arm gets equal impressions". Per segment, the shoppers who scroll
// each day (the engine's own keyed reach draw) are put in a keyed order and dealt arms
// round-robin, continuing across the round's days from a keyed starting arm. Within a segment,
// arm counts for the round differ by at most one.
export function balancedPolicy(shoppers: () => readonly Shopper[]): ArmPolicy {
  const deals = new Map<string, Map<string, number>>();
  return (shopper, arms, { seed, tick }) => {
    const segment = shopper.segment_id;
    const key = `${segment}|${tick}`;
    let deal = deals.get(key);
    if (!deal) {
      const scrolling = (t: number) =>
        shoppers()
          .filter((s) => s.segment_id === segment && bernoulli(config.run.reach, seed, "reach", s.shopper_id, t))
          .map((s) => s.shopper_id);
      const roundStart = tick - (tick % config.run.ticksPerRound);
      let dealt = Math.floor(uniform(seed, "arm", "warm_up", segment, roundStart) * arms.length);
      for (let t = roundStart; t < tick; t++) dealt += scrolling(t).length;
      const order = shuffle(scrolling(tick), seed, "arm", "warm_up", segment, tick);
      deal = new Map(order.map((id, i) => [id, (dealt + i) % arms.length]));
      deals.set(key, deal);
    }
    const i = deal.get(shopper.shopper_id);
    if (i === undefined) throw new Error(`${shopper.shopper_id} isn't scrolling at tick ${tick}`);
    return arms[i]!;
  };
}

// The contract's decision row: one per Jev call. `options` also carries the state's cache
// key (the plan's "state hash"), and `draw` holds every uniform the call's dice used.
export type DecisionRow = {
  run_id: string;
  round: number;
  tick: number;
  shopper_id: string;
  kind: "feed" | "page";
  creative_id: string;
  options: { state_hash: string; order?: string[]; objections?: string[] };
  p_raw: Record<string, unknown>;
  p_cal: Record<string, unknown>;
  draw: Record<string, number | null>;
  action: string;
  believes_claim: number | null;
  objection: string | null;
  latency_ms: number;
  cache_hit: boolean;
};

export type Gates = { tap: number; stay: number; buy: number };

// One impression of our ad, with what the reward and the summary need.
export type Impression = {
  round: number;
  tick: number;
  shopper_id: string;
  segment_id: string;
  arm_id: string;
  creative_id: string;
  in_market: boolean;
  p_raw: Gates;
  p_cal: Gates;
  guard: 0 | 1;
  // Expected orders per impression: P(tap) × P(stay) × P(buy | stay) × guard.
  reward_raw: number;
  reward_cal: number;
  believes: number;
  objection: Objection;
  tapped: boolean;
  stayed: boolean;
  bought: boolean;
  lost_to_competitor: boolean;
};

export type DayResult = {
  round: number;
  tick: number;
  decisions: DecisionRow[];
  impressions: Impression[];
  // Billed input tokens of the day's calls, counted the same whether answered fresh or cached.
  inputTokens: number;
};

export type EngineOptions = {
  run_id: string;
  seed: number;
  population: number;
  offsets?: Offsets;
  policy?: ArmPolicy;
};

export class Engine {
  readonly shoppers: Shopper[];
  // The exact text Jev last read for each shopper (the shopper row's state_text).
  readonly lastState = new Map<string, { feed: string; page: string }>();
  readonly run_id: string;
  readonly seed: number;
  readonly offsets: Offsets;
  private policy: ArmPolicy;
  private liveArms: Arm[];
  private armCreatives = new Map<string, Creative[]>();
  private products = new Map<string, Product>();
  private segments = new Map<string, Segment>();

  constructor(
    readonly world: World,
    private jev: Asker,
    private perceptions: Map<string, Perception>,
    opts: EngineOptions,
  ) {
    this.run_id = opts.run_id;
    this.seed = opts.seed;
    this.offsets = opts.offsets ?? ZERO_OFFSETS;
    this.policy = opts.policy ?? uniformPolicy;
    this.shoppers = Array.from({ length: opts.population }, (_, i) => makeShopper(i, world, opts.seed));
    for (const p of world.products) this.products.set(p.product_id, p);
    for (const s of world.segments) this.segments.set(s.segment_id, s);
    const client = world.brands.find((b) => b.is_client)!;
    for (const c of world.creatives) {
      if (c.arm_id && c.brand_id === client.brand_id && c.status === "ranked") {
        this.armCreatives.set(c.arm_id, [...(this.armCreatives.get(c.arm_id) ?? []), c]);
      }
    }
    // Only ranked creatives enter feeds, so an arm with none can't be shown.
    this.liveArms = world.arms.filter((a) => this.armCreatives.has(a.arm_id));
    for (const c of world.creatives) {
      if (!this.perceptions.has(c.creative_id)) throw new Error(`creative ${c.creative_id} has no perception`);
    }
  }

  // Arms with at least one ranked Magic Spoon creative, in fixture order.
  get arms(): readonly Arm[] {
    return this.liveArms;
  }

  claimed(creative: Creative): string[] {
    return claimedConcepts(this.perceptions.get(creative.creative_id));
  }

  ticksOf(round: number): number[] {
    const n = config.run.ticksPerRound;
    return Array.from({ length: n }, (_, i) => round * n + i);
  }

  async runRound(round: number): Promise<DayResult[]> {
    const days: DayResult[] = [];
    for (const tick of this.ticksOf(round)) days.push(await this.runDay(round, tick));
    return days;
  }

  async runDay(round: number, tick: number): Promise<DayResult> {
    const results = await Promise.all(this.shoppers.map((s) => this.shopperDay(s, round, tick)));
    const decisions: DecisionRow[] = [];
    const impressions: Impression[] = [];
    let inputTokens = 0;
    for (const r of results) {
      if (!r) continue;
      decisions.push(...r.decisions);
      impressions.push(r.impression);
      inputTokens += r.inputTokens;
    }
    return { round, tick, decisions, impressions, inputTokens };
  }

  // Our ad for today: the policy's arm, then one of its creatives written for this shopper's
  // segment, falling back to any of the arm's creatives (the control's live ads have none).
  pickCreative(shopper: Shopper, round: number, tick: number): { arm: Arm; creative: Creative } {
    const arm = this.policy(shopper, this.liveArms, { seed: this.seed, round, tick });
    const pool = this.armCreatives.get(arm.arm_id)!;
    const forSegment = pool.filter((c) => c.segment_id === shopper.segment_id);
    const choices = forSegment.length ? forSegment : pool;
    const creative = choices[Math.floor(uniform(this.seed, "variant", shopper.shopper_id, tick) * choices.length)]!;
    return { arm, creative };
  }

  private async shopperDay(
    shopper: Shopper,
    round: number,
    tick: number,
  ): Promise<{ decisions: DecisionRow[]; impression: Impression; inputTokens: number } | null> {
    const { seed } = this;
    const id = shopper.shopper_id;
    const segment = this.segments.get(shopper.segment_id)!;

    // 1. Needs. 2. Reach.
    updateNeed(shopper, tick, bernoulli(segment.in_market_rate, seed, "need", id, tick));
    if (!bernoulli(config.run.reach, seed, "reach", id, tick)) return null;

    // 3. Our ad. 4-5. Neighbours and order.
    const { arm, creative: ours } = this.pickCreative(shopper, round, tick);
    const options = assembleFeed(shopper, ours, this.world, seed, tick);
    const product = this.products.get(ours.landing_product_id ?? "");
    if (!product) throw new Error(`creative ${ours.creative_id} has no landing product`);

    // 6-7. Feed and page calls, both rendered from the state before today's events. The page
    // call is asked whether or not the ad gets tapped, because the reward needs it.
    const claimedOurs = this.claimed(ours);
    const claimedToday = [...new Set([...claimedOurs, ...options.flatMap((o) => this.claimed(o.creative))])];
    const feedState = renderFeedState(shopper, this.world, tick, options.map((o) => o.creative), claimedToday);
    // The page call keeps SHOPPER and MEMORY exactly as the feed call showed them.
    const pageState = renderPageState(shopper, this.world, tick, ours, product, claimedToday);
    this.lastState.set(id, { feed: feedState, page: pageState });
    const [feed, page] = await Promise.all([
      this.jev.ask(feedState, feedQuestions(options, ours, this.world)),
      this.jev.ask(pageState, PAGE_QUESTIONS),
    ]);

    // 8. Guard, then calibrate. The budget enters only here (rendering rule 4).
    const tapRaw = tapProbabilities(options, feed.answers);
    const tapCal = Object.fromEntries(Object.entries(tapRaw).map(([k, p]) => [k, calibrate(p, this.offsets.tap)]));
    const guard: 0 | 1 = product.price_usd > shopper.budget_left_usd ? 0 : 1;
    const pRaw: Gates = { tap: tapRaw[ours.creative_id]!, stay: page.answers.stays.noul, buy: page.answers.buys.noul };
    const pCal: Gates = {
      tap: tapCal[ours.creative_id]!,
      stay: calibrate(pRaw.stay, this.offsets.stay),
      buy: guard ? calibrate(pRaw.buy, this.offsets.buy) : 0,
    };
    const objectionP = page.answers.objection.probabilities;
    const objection = topObjection(objectionP);
    const inMarket = shopper.in_market;

    // 9. Dice. The three tap Nouls are independent, so our tap is drawn from P(tap ours) alone;
    // a competitor tap is drawn only when ours isn't, and only counts as lost (SPIKE.md).
    const uTap = uniform(seed, "tap", id, tick, ours.creative_id);
    const tapped = uTap < pCal.tap;
    const uStay = tapped ? uniform(seed, "stay", id, tick) : null;
    const stayed = uStay !== null && uStay < pCal.stay;
    const uBuy = stayed ? uniform(seed, "buy", id, tick) : null;
    const bought = uBuy !== null && uBuy < pCal.buy;
    const lost =
      !tapped &&
      options.some(
        (o) => o.creative !== ours && bernoulli(tapCal[o.creative.creative_id]!, seed, "tap", id, tick, o.creative.creative_id),
      );

    // 10. Memory: every ad seen, then the evidence table on our ad's claimed concepts.
    this.remember(shopper, tick, options, ours, product, claimedOurs, { tapped, stayed, bought });

    const base = { run_id: this.run_id, round, tick, shopper_id: id, creative_id: ours.creative_id };
    const decisions: DecisionRow[] = [
      {
        ...base,
        kind: "feed",
        options: { state_hash: feed.cacheKey, order: options.map((o) => o.creative.creative_id) },
        p_raw: { tap: tapRaw, believes: feed.answers.believes.noul },
        p_cal: { tap: tapCal },
        draw: { tap: uTap },
        action: tapped ? "tap" : lost ? "lost_to_competitor" : "scroll",
        believes_claim: feed.answers.believes.noul,
        objection: null,
        latency_ms: feed.latencyMs,
        cache_hit: feed.cacheHit,
      },
      {
        ...base,
        kind: "page",
        options: { state_hash: page.cacheKey, objections: Object.keys(PAGE_QUESTIONS.objection.criteria) },
        p_raw: { stay: pRaw.stay, buy: pRaw.buy, objection: objectionP },
        p_cal: { stay: pCal.stay, buy: pCal.buy, guard },
        draw: { stay: uStay, buy: uBuy },
        action: !tapped ? "not_tapped" : bought ? "buy" : stayed ? "stay" : "bounce",
        believes_claim: null,
        objection,
        latency_ms: page.latencyMs,
        cache_hit: page.cacheHit,
      },
    ];
    const impression: Impression = {
      round,
      tick,
      shopper_id: id,
      segment_id: shopper.segment_id,
      arm_id: arm.arm_id,
      creative_id: ours.creative_id,
      in_market: inMarket,
      p_raw: pRaw,
      p_cal: pCal,
      guard,
      reward_raw: pRaw.tap * pRaw.stay * pRaw.buy * guard,
      reward_cal: pCal.tap * pCal.stay * pCal.buy,
      believes: feed.answers.believes.noul,
      objection,
      tapped,
      stayed,
      bought,
      lost_to_competitor: lost,
    };
    const inputTokens = (feed.usage.input_tokens ?? 0) + (page.usage.input_tokens ?? 0);
    return { decisions, impression, inputTokens };
  }

  private remember(
    shopper: Shopper,
    tick: number,
    options: FeedOption[],
    ours: Creative,
    product: Product,
    claimedOurs: string[],
    outcome: { tapped: boolean; stayed: boolean; bought: boolean },
  ): void {
    for (const o of options) {
      shopper.exposures.push({ tick, creative_id: o.creative.creative_id, brand_id: o.creative.brand_id, concepts: this.claimed(o.creative) });
    }
    if (!outcome.tapped) return;
    const engage = (kind: "tap" | "stay" | "buy") => {
      applyEvidence(shopper, kind, ours.brand_id, claimedOurs);
      shopper.engagements.push({ tick, creative_id: ours.creative_id, kind });
    };
    engage("tap");
    // Events are cumulative (D38): a tap that bounces keeps its TAP row; leaving within seconds
    // adds nothing more and sees no price.
    if (!outcome.stayed) return;
    engage("stay");
    seePrice(shopper, product);
    if (!outcome.bought) return;
    engage("buy");
    purchase(shopper, product.price_usd);
  }
}

// The objection Choice's most likely answer; ties go to the earlier option.
function topObjection(p: Record<string, number>): Objection {
  let best: Objection = "nothing";
  let bestP = -1;
  for (const k of Object.keys(PAGE_QUESTIONS.objection.criteria) as Objection[]) {
    if ((p[k] ?? 0) > bestP) {
      best = k;
      bestP = p[k] ?? 0;
    }
  }
  return best;
}

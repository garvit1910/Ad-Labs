import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { armSchema, creativeSchema, segmentSchema } from "../src/contract.js";
import { assembleFeed, feedQuestions, tapProbabilities } from "../src/feed.js";
import { checkWorld, loadWorld } from "../src/fixtures.js";
import { JevClient, JevError } from "../src/jev.js";
import { makeShopper } from "../src/population.js";
import { memoryLines, preferenceLine, renderAd, renderFeedState, wordCount } from "../src/render.js";
import { normal, shuffle, uniform } from "../src/rng.js";

const world = loadWorld();
const SEED = 13;
const shopper = (i: number) => makeShopper(i, world, SEED);
const ourAd = (s: ReturnType<typeof shopper>) =>
  world.creatives.find((c) => c.origin === "generated" && c.segment_id === s.segment_id)!;
const feedAds = (s: ReturnType<typeof shopper>, tick = 0) => assembleFeed(s, ourAd(s), world, SEED, tick).map((o) => o.creative);
const conceptCount = (line: string) =>
  line
    .split(/(?:Cares a lot about|Cares somewhat about|Doesn't think about): /)
    .slice(1)
    .reduce((n, part) => n + part.replace(/\.\s*$/, "").split(/, | and /).length, 0);

describe("contract schemas", () => {
  const arm = { arm_id: "arm_x", rationale: "r", evidence: [] };
  test("recipes need both angle and hook; control needs neither", () => {
    assert.equal(armSchema.safeParse({ ...arm, strategy: "steal", angle: null, hook: "question" }).success, false);
    assert.equal(armSchema.safeParse({ ...arm, strategy: "gap", angle: "craving", hook: null }).success, false);
    assert.equal(armSchema.safeParse({ ...arm, strategy: "steal", angle: "craving", hook: "question" }).success, true);
    assert.equal(armSchema.safeParse({ ...arm, strategy: "control", angle: null, hook: null }).success, true);
    assert.equal(armSchema.safeParse({ ...arm, strategy: "control", angle: "craving", hook: null }).success, false);
  });
  test("hooks outside the producible list are rejected", () => {
    for (const hook of ["demo", "comparison", "other"]) {
      assert.equal(armSchema.safeParse({ ...arm, strategy: "steal", angle: "craving", hook }).success, false, hook);
    }
  });
  test("json columns accept SpacetimeDB strings or parsed values", () => {
    const seg = world.segments[0]!;
    const asStrings = { ...seg, prior_weights: JSON.stringify(seg.prior_weights), quotes: JSON.stringify(seg.quotes) };
    assert.deepEqual(segmentSchema.parse(asStrings), seg);
    assert.equal(armSchema.safeParse({ ...arm, strategy: "control", angle: null, hook: null, evidence: '["cr_1"]' }).success, true);
  });
  test("empty means \"\" or null, and extra fields are rejected", () => {
    const c = world.creatives.find((x) => x.origin === "competitor_live")!;
    assert.equal(creativeSchema.parse({ ...c, arm_id: "", segment_id: "" }).arm_id, null);
    assert.equal(creativeSchema.safeParse({ ...c, extra: 1 }).success, false);
  });
});

describe("fixtures", () => {
  test("load clean and match B0's counts", () => {
    const { errors } = checkWorld(world);
    assert.deepEqual(errors, []);
    assert.equal(world.segments.length, 6);
    const recipes = world.arms.filter((a) => a.strategy !== "control");
    assert.ok(recipes.length >= 10 && recipes.length <= 12);
    assert.equal(world.arms.filter((a) => a.strategy === "control").length, 1);
    for (const a of recipes) assert.equal(world.creatives.filter((c) => c.arm_id === a.arm_id).length, 1, a.arm_id);
    const brandLive = world.creatives.filter((c) => c.origin === "brand_live").length;
    assert.ok(brandLive >= 2 && brandLive <= 3);
    for (const b of world.brands.filter((x) => !x.is_client)) {
      assert.equal(world.creatives.filter((c) => c.brand_id === b.brand_id).length, 2, b.brand_id);
    }
    for (const s of world.segments) assert.ok(s.quotes.length >= 3 && s.quotes.length <= 5, s.segment_id);
  });
  test("strategy counts follow the arm builder", () => {
    const n = (s: string) => world.arms.filter((a) => a.strategy === s).length;
    assert.ok(n("steal") >= 4 && n("steal") <= 5);
    assert.ok(n("double_down") >= 2 && n("double_down") <= 3);
    assert.ok(n("gap") >= 2 && n("gap") <= 3);
  });
  test("a sparse prior is a warning, not an error, and renders as unheld", () => {
    const seg = world.segments[0]!;
    const { taste: _drop, ...rest } = seg.prior_weights;
    const sparse = { ...world, segments: [{ ...seg, prior_weights: rest }, ...world.segments.slice(1)] };
    const { errors, warnings } = checkWorld(sparse);
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => w.includes("treated as unheld")));
  });
  test("segment descriptions carry no segment names", () => {
    for (const s of world.segments) assert.ok(!s.description.toLowerCase().includes(s.name.toLowerCase()), s.segment_id);
  });
});

describe("population", () => {
  test("shopper is independent of population size and order", () => {
    assert.deepEqual(makeShopper(250, world, SEED), shopper(250));
  });
  test("preferences: N(prior, 0.08) clipped to 0.05-0.95, E = 2", () => {
    for (let i = 0; i < 200; i++) {
      for (const p of Object.values(shopper(i).preferences)) {
        assert.ok(p.w >= 0.05 && p.w <= 0.95);
        assert.equal(p.E, 2);
      }
    }
  });
  test("budget floor $15, two distinct quotes, empty memory", () => {
    for (let i = 0; i < 500; i++) {
      const s = shopper(i);
      assert.ok(s.budget_left_usd >= 15);
      assert.equal(new Set(s.quotes).size, 2);
      assert.deepEqual([s.exposures, s.engagements, s.opinions], [[], [], {}]);
    }
  });
  test("starting flag does not reuse the tick-0 arrival draw", () => {
    let same = 0;
    for (let i = 0; i < 2000; i++) {
      const s = shopper(i);
      const seg = world.segments.find((x) => x.segment_id === s.segment_id)!;
      if (s.in_market === uniform(SEED, "need", s.shopper_id, 0) < seg.in_market_rate) same++;
    }
    assert.ok(same < 2000 * 0.95, `${same}/2000 identical`);
  });
});

describe("rng", () => {
  test("deterministic, and separate streams are separate", () => {
    assert.equal(uniform(SEED, "tap", "a", 1), uniform(SEED, "tap", "a", 1));
    assert.notEqual(uniform(SEED, "tap", "a", 1), uniform(SEED, "buy", "a", 1));
  });
  test("normal and shuffle are sane", () => {
    const xs = Array.from({ length: 4000 }, (_, i) => normal(0, 1, SEED, "population", i));
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    assert.ok(Math.abs(m) < 0.06);
    assert.deepEqual([...shuffle([1, 2, 3, 4], SEED, "order", 1)].sort(), [1, 2, 3, 4]);
  });
});

describe("rendering rules", () => {
  test("rule 1: every fixture state is under 450 words", () => {
    for (let i = 0; i < 300; i++) assert.ok(wordCount(renderFeedState(shopper(i), world, 0, feedAds(shopper(i)))) <= 450);
  });
  test("rule 2 and 4: no segment name, no budget", () => {
    for (let i = 0; i < 300; i++) {
      const s = shopper(i);
      const state = renderFeedState(s, world, 0, feedAds(s));
      const seg = world.segments.find((x) => x.segment_id === s.segment_id)!;
      assert.ok(!state.includes(seg.name));
      assert.ok(!state.includes("$"), "no money in a fresh state, so no budget");
    }
  });
  test("rule 5: literal abstention lines for a fresh shopper", () => {
    assert.deepEqual(memoryLines(shopper(0), world, 0), ["Has never seen a Magic Spoon ad.", "No opinion of Magic Spoon yet."]);
  });
  test("rule 7: at most 6 concepts, strongest kept even when ads claim many", () => {
    const s = shopper(0);
    const claimed = world.concepts.map((c) => c.key);
    const line = preferenceLine(s, world, claimed);
    assert.ok(conceptCount(line) <= 6, line);
    const top3 = Object.entries(s.preferences).filter(([k]) => k !== "other").sort(([, a], [, b]) => b.w - a.w).slice(0, 3);
    for (const [k] of top3) assert.ok(line.includes(world.concepts.find((c) => c.key === k)!.label), k);
    assert.ok(!/\bother\b/.test(line));
  });
  test("rule 7: a claimed low-weight concept appears under \"Doesn't think about\"", () => {
    const s = shopper(0);
    const low = Object.entries(s.preferences).filter(([k, p]) => k !== "other" && p.w < 0.45)[0]![0];
    const line = preferenceLine(s, world, [low]);
    assert.match(line, /Doesn't think about: /);
    assert.ok(line.includes(world.concepts.find((c) => c.key === low)!.label));
  });
  test("rule 7 thresholds: 0.70 a lot, 0.45 somewhat, below 0.45 not", () => {
    const s = shopper(0);
    for (const p of Object.values(s.preferences)) p.w = 0.1;
    s.preferences.taste!.w = 0.7;
    s.preferences.crunch_texture!.w = 0.45;
    s.preferences.low_sugar!.w = 0.4499;
    const line = preferenceLine(s, world, ["low_sugar"]);
    assert.match(line, /Cares a lot about: taste\./);
    assert.match(line, /Cares somewhat about: crunch\./);
    assert.match(line, /Doesn't think about: .*low sugar/);
  });
  test("memory lines follow the template once memory is populated (rules 3 and 8)", () => {
    const s = shopper(0);
    s.exposures.push(
      { tick: 1, creative_id: "cr_gen_03", brand_id: "br_magic_spoon", concepts: ["high_protein", "other"] },
      { tick: 2, creative_id: "cr_gen_07", brand_id: "br_magic_spoon", concepts: ["high_protein"] },
      { tick: 3, creative_id: "cr_gen_01", brand_id: "br_magic_spoon", concepts: ["taste"] },
      { tick: 3, creative_id: "cr_gen_02", brand_id: "br_magic_spoon", concepts: ["other"] },
      { tick: 2, creative_id: "cr_cc_live_1", brand_id: "br_catalina_crunch", concepts: [] },
      { tick: 3, creative_id: "cr_cc_live_2", brand_id: "br_catalina_crunch", concepts: [] },
    );
    s.engagements.push({ tick: 2, creative_id: "cr_gen_07", kind: "tap" }, { tick: 2, creative_id: "cr_gen_07", kind: "stay" });
    s.opinions.br_magic_spoon = { value: 0.62, E: 0.75, page_visits: 1, purchases: 0 };
    s.expected_price_usd.prd_magic_spoon_variety_4pk = 39.6;
    assert.deepEqual(memoryLines(s, world, 4), [
      "Has seen Magic Spoon ads 4 times this week, mostly about high protein.",
      "Has also seen Catalina Crunch ads twice this week.",
      "Opinion of Magic Spoon: likes it, from one page visit.",
      "Tapped a Magic Spoon ad 2 days ago, looked at the page, didn't buy.",
      "Thinks the Magic Spoon Variety 4-Pack costs about $40.",
    ]);
    s.opinions.br_magic_spoon = { value: 0.5, E: 2, page_visits: 2, purchases: 0 };
    assert.equal(memoryLines(s, world, 4)[2], "Opinion of Magic Spoon: mixed, from two page visits.");
    s.opinions.br_magic_spoon = { value: 0.3, E: 2, page_visits: 2, purchases: 1 };
    assert.equal(memoryLines(s, world, 4)[2], "Opinion of Magic Spoon: skeptical, from a purchase.");
    assert.equal(memoryLines(s, world, 12)[0], "Hasn't seen a Magic Spoon ad this week.");
  });
  test("rule 1 is enforced by the renderer", () => {
    const s = shopper(0);
    const big = { ...world, segments: world.segments.map((g) => ({ ...g, description: "word ".repeat(500) })) };
    assert.throws(() => renderFeedState(s, big, 0, feedAds(s)), /limit under 450/);
  });
});

describe("feed", () => {
  const s = shopper(0);
  const ours = world.creatives.find((c) => c.creative_id === "cr_gen_07")!;
  test("our ad plus 2 distinct ranked competitor ads, neutral letters, seeded order", () => {
    const feed = assembleFeed(s, ours, world, SEED, 0);
    assert.deepEqual(feed.map((o) => o.key), ["A", "B", "C"]);
    assert.equal(feed.filter((o) => o.creative === ours).length, 1);
    const nb = feed.filter((o) => o.creative !== ours);
    assert.ok(nb.every((o) => o.creative.origin === "competitor_live" && o.creative.status === "ranked"));
    assert.notEqual(nb[0]!.creative.creative_id, nb[1]!.creative.creative_id);
    assert.deepEqual(assembleFeed(s, ours, world, SEED, 0), feed);
  });
  test("gated_out competitor ads never enter the feed", () => {
    const gated = { ...world, creatives: world.creatives.map((c) => (c.creative_id === "cr_cc_live_1" ? { ...c, status: "gated_out" as const } : c)) };
    for (let t = 0; t < 200; t++) {
      assert.ok(!assembleFeed(s, ours, gated, SEED, t).some((o) => o.creative.creative_id === "cr_cc_live_1"));
    }
  });
  test("feed changes across run-wide ticks", () => {
    const seen = new Set<string>();
    for (let t = 0; t < 15; t++) seen.add(assembleFeed(s, ours, world, SEED, t).map((o) => o.creative.creative_id).join());
    assert.ok(seen.size > 5);
  });
  test("feed call (B1 shape): posts listed in the state in feed order, one tap Noul per post", () => {
    const feed = assembleFeed(s, ours, world, SEED, 0);
    const state = renderFeedState(s, world, 0, feed.map((o) => o.creative));
    const listed = state.split("\n").filter((l) => l.startsWith("- "));
    assert.deepEqual(listed, feed.map((o) => `- ${renderAd(o.creative, world)}`));
    assert.match(state, /RIGHT NOW\nScrolling Instagram on their phone\. Three sponsored posts appear one after another:\n- /);
    const q = feedQuestions(feed, ours, world);
    assert.deepEqual(Object.keys(q), ["tap_A", "tap_B", "tap_C", "believes"]);
    for (const o of feed) {
      assert.equal(q[`tap_${o.key}`].type, "noul");
      assert.ok(q[`tap_${o.key}`].instructions.startsWith("Does this shopper tap the "), o.key);
      assert.ok(q[`tap_${o.key}`].instructions.includes(`says "${o.creative.headline.replace(/^"(.*)"$/, "$1")}"`), o.key);
    }
    // Plan wording exactly, now that the post itself is in the state; testimonial quotes not doubled.
    assert.equal(q.believes.instructions, 'Does this shopper believe the main promise of the Magic Spoon post that says "I finally hit my protein goal at breakfast"?');
  });
  test("tapProbabilities maps each tap answer to its creative", () => {
    const feed = assembleFeed(s, ours, world, SEED, 0);
    const answers = { tap_A: { type: "noul" as const, noul: 0.1 }, tap_B: { type: "noul" as const, noul: 0.2 }, tap_C: { type: "noul" as const, noul: 0.3 } };
    const p = tapProbabilities(feed, answers);
    assert.deepEqual(feed.map((o) => p[o.creative.creative_id]), [0.1, 0.2, 0.3]);
  });
});

describe("jev wrapper (stubbed fetch)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const qs = {
    tap: { type: "choice" as const, instructions: "Which?", criteria: { A: "a", B: "b", none: "n" } },
    believes: { type: "noul" as const, instructions: "Believe?" },
  };
  const good = (model = "jev-1.13.0") => ({
    model,
    answers: {
      tap: { type: "choice", choice: "none", confidence: 0.8, probabilities: { A: 0.1, B: 0.1, none: 0.8 } },
      believes: { type: "noul", noul: 0.4 },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  const stub = (responses: (() => Response)[]) => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return responses.shift()!();
    }) as typeof fetch;
    return () => calls;
  };
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

  test("retries a 429, then caches", async () => {
    const calls = stub([() => new Response("slow", { status: 429, headers: { "retry-after": "0.01" } }), json(good())]);
    const c = new JevClient({ apiKey: "k", cachePath: join(dir, "a.sqlite") });
    const r1 = await c.ask("s", qs);
    const r2 = await c.ask("s", qs);
    assert.equal(calls(), 2);
    assert.deepEqual([r1.cacheHit, r2.cacheHit, r2.answers.tap.probabilities.none], [false, true, 0.8]);
    c.close();
  });
  test("identical concurrent requests make one call", async () => {
    const calls = stub([json(good())]);
    const c = new JevClient({ apiKey: "k", cachePath: null });
    const [a, b] = await Promise.all([c.ask("same", qs), c.ask("same", qs)]);
    assert.equal(calls(), 1);
    assert.deepEqual(a.answers, b.answers);
    c.close();
  });
  test("rejects (never throws) on bad responses", async () => {
    const c = new JevClient({ apiKey: "k", cachePath: null });
    const cases: [string, () => Response, RegExp][] = [
      ["missing answer", json({ ...good(), answers: { tap: good().answers.tap } }), /missing answer/],
      ["wrong options", json({ ...good(), answers: { ...good().answers, tap: { ...good().answers.tap, probabilities: { A: 1 } } } }), /options/],
      ["bad schema", json({ model: "jev-1.13.0", answers: { tap: { type: "choice" } }, usage: {} }), /validation/],
      ["other model", json(good("jev-1.14.0")), /answered by jev-1.14.0/],
      ["422", json({ detail: [] }, 422), /HTTP 422/],
    ];
    for (const [name, res, err] of cases) {
      stub([res]);
      const p = c.ask(name, qs);
      assert.ok(p instanceof Promise, name);
      await assert.rejects(p, (e: unknown) => e instanceof JevError && err.test(e.message), name);
    }
    c.close();
  });
  test("a cached answer from another model is rejected", async () => {
    const path = join(dir, "b.sqlite");
    stub([json(good())]);
    const latest = new JevClient({ apiKey: "k", model: "jev-latest", cachePath: path });
    stub([json(good("jev-1.14.0"))]);
    await latest.ask("s", qs); // an alias may resolve to any version
    latest.close();
    const pinned = new JevClient({ apiKey: "k", cachePath: path });
    stub([json(good())]);
    const r = await pinned.ask("s", qs); // different model in the key: fresh call, not the alias's row
    assert.equal(r.cacheHit, false);
    pinned.close();
  });
});

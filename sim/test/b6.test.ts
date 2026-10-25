import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { JevClient } from "../src/jev.js";
import {
  REORDERED,
  confoundersOf,
  diffImpression,
  effectSize,
  explainedShare,
  findReason,
  mainGate,
  parseSeen,
  pickPinned,
  rankCandidates,
  stateLines,
  swapLine,
} from "../src/pin.js";
import { compareRuns } from "../src/replay.js";
import { Worker } from "../src/worker.js";
import { FakeDb } from "./fake-db.js";
import { fakeJev } from "./fake-jev.js";

const quiet = () => {};

const NOT_SHOPPING = "Not shopping for cereal right now.";
const SHOPPING = "Shopping for a new cereal right now and wants to buy within a few days.";
const feedState = (need: string, seen: string, posts = ["- Magic Spoon: ours", "- Catalina Crunch: theirs", "- Three Wishes: theirs"]) =>
  [
    `SHOPPER\nSam B. A parent.\nIn their own words: "x"\nCares a lot about: taste.\n${need}`,
    `MEMORY\n${seen}\nNo opinion of Magic Spoon yet.`,
    ["RIGHT NOW", "Scrolling Instagram on their phone. Three sponsored posts appear one after another:", ...posts].join("\n"),
  ].join("\n\n");
const pageState = (need: string, seen: string, price = "first time seeing a price.") =>
  [
    `SHOPPER\nSam B. A parent.\nIn their own words: "x"\nCares a lot about: taste.\n${need}`,
    `MEMORY\n${seen}\nNo opinion of Magic Spoon yet.`,
    "THEY TAPPED\nMagic Spoon: ours",
    `THE PAGE\nMagic Spoon Variety 4-Pack — $39 one-time.\nPrice compared with what they expected: ${price}`,
  ].join("\n\n");
const states = (need: string, seen: string, posts?: string[], price?: string) => ({ feed: feedState(need, seen, posts), page: pageState(need, seen, price) });
const SEEN_2 = "Has seen Magic Spoon ads twice this week, mostly about taste.";
const SEEN_5 = "Has seen Magic Spoon ads 5 times this week, mostly about taste.";

describe("B6 pin: reading what changed between two impressions", () => {
  test("stateLines keeps SHOPPER and MEMORY only", () => {
    const lines = stateLines(feedState(NOT_SHOPPING, SEEN_2));
    assert.ok(lines.includes(NOT_SHOPPING) && lines.includes(SEEN_2));
    assert.ok(!lines.some((l) => l.startsWith("- ") || l === "RIGHT NOW"));
  });

  test("parseSeen reads once, twice, N times and never", () => {
    assert.deepEqual(parseSeen("Has seen Magic Spoon ads once this week."), { count: 1, about: null });
    assert.deepEqual(parseSeen(SEEN_2), { count: 2, about: "taste" });
    assert.deepEqual(parseSeen(SEEN_5), { count: 5, about: "taste" });
    assert.deepEqual(parseSeen("Has never seen a Magic Spoon ad."), { count: 0, about: null });
    assert.equal(parseSeen("Has also seen Catalina Crunch ads twice this week."), null);
  });

  test("a new shopping flag is a need reason; one that ends is not", () => {
    const arrive = diffImpression(states(NOT_SHOPPING, SEEN_2), states(SHOPPING, SEEN_2));
    assert.deepEqual(findReason(arrive, 0.01, 0.02), { kind: "need", before: NOT_SHOPPING, after: SHOPPING });
    const leave = diffImpression(states(SHOPPING, SEEN_2), states(NOT_SHOPPING, SEEN_2));
    assert.equal(findReason(leave, 0.02, 0.01), null);
  });

  test("wear-out needs more showings on the same concept and a falling tap chance", () => {
    const d = diffImpression(states(SHOPPING, SEEN_2), states(SHOPPING, SEEN_5));
    assert.deepEqual(findReason(d, 0.02, 0.01), { kind: "wear_out", before: SEEN_2, after: SEEN_5 });
    assert.equal(findReason(d, 0.01, 0.02), null);
    const otherConcept = diffImpression(states(SHOPPING, SEEN_2), states(SHOPPING, "Has seen Magic Spoon ads 5 times this week, mostly about high protein."));
    assert.equal(findReason(otherConcept, 0.02, 0.01), null);
  });

  test("confounders: whatever still differs once the reason line is put back", () => {
    const reason = { before: NOT_SHOPPING, after: SHOPPING };
    assert.deepEqual(confoundersOf(states(NOT_SHOPPING, SEEN_2), states(SHOPPING, SEEN_2), reason), []);
    // Other changes in any block count: memory, the feed's neighbours, the page's price line.
    const busy = confoundersOf(
      states(NOT_SHOPPING, SEEN_2),
      states(SHOPPING, SEEN_5, ["- Magic Spoon: ours", "- Wonderworks: other", "- Three Wishes: theirs"], "about what they expected."),
      reason,
    );
    assert.ok(busy.includes(SEEN_2) && busy.includes(SEEN_5));
    assert.ok(busy.includes("- Catalina Crunch: theirs") && busy.includes("- Wonderworks: other"));
    assert.ok(busy.some((l) => l.includes("about what they expected")));
    // The same posts in another order still changes what Jev reads.
    const reordered = confoundersOf(
      states(NOT_SHOPPING, SEEN_2),
      states(SHOPPING, SEEN_2, ["- Catalina Crunch: theirs", "- Magic Spoon: ours", "- Three Wishes: theirs"]),
      reason,
    );
    assert.deepEqual(reordered, [REORDERED]);
  });

  test("swapLine replaces or drops one exact line", () => {
    const s = feedState(NOT_SHOPPING, SEEN_2);
    assert.equal(swapLine(s, NOT_SHOPPING, SHOPPING), feedState(SHOPPING, SEEN_2));
    assert.ok(!swapLine(s, NOT_SHOPPING, null).includes(NOT_SHOPPING));
  });

  test("effect, main gate and the explained share", () => {
    const a = { tap: 0.01, stay: 0.5, buy: 0.04, guard: 1 as const };
    const b = { tap: 0.012, stay: 0.5, buy: 0.08, guard: 1 as const };
    assert.equal(mainGate(a, b), "buy");
    assert.ok(Math.abs(effectSize(a, b) - Math.log(2)) < 1e-12);
    // With the guard off, buy doesn't count.
    assert.equal(mainGate({ ...a, guard: 0 }, b), "tap");
    assert.equal(explainedShare(0.04, 0.08, 0.04), 1);
    assert.equal(explainedShare(0.04, 0.08, 0.08), 0);
    assert.equal(explainedShare(0.04, 0.04, 0.05), null);
  });

  test("ranking prefers fewer confounders, then the same ad, then bigger changes; the pick needs the line to explain at least half", () => {
    const reason = { kind: "need" as const, before: NOT_SHOPPING, after: SHOPPING };
    const c = (confounders: number, sameCreative: boolean, effect: number, explained: number | null = null) => ({
      reason,
      confounders: Array.from({ length: confounders }, (_, i) => `x${i}`),
      sameCreative,
      effect,
      explained,
    });
    const ranked = rankCandidates([c(2, true, 3), c(0, false, 1), c(0, true, 0.5), c(0, true, 2)]);
    assert.deepEqual(ranked.map((r) => [r.confounders.length, r.sameCreative, r.effect]), [[0, true, 2], [0, true, 0.5], [0, false, 1], [2, true, 3]]);
    // A big change the line barely explains loses to a smaller one it fully explains.
    assert.equal(pickPinned([c(0, true, 1.3, 0.28), c(4, true, 0.86, 1)])!.effect, 0.86);
    // When nothing is explained well enough, the biggest change wins.
    assert.equal(pickPinned([c(0, true, 0.4, 0.1), c(0, true, 0.9, 0.2)])!.effect, 0.9);
  });
});

describe("B6 replay: offline, off the task board, identical", () => {
  test("an offline Jev client refuses a cache miss instead of calling Jev", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b6-jev-"));
    try {
      const jev = new JevClient({ cachePath: join(dir, "cache.sqlite"), offline: true, apiKey: "unused" });
      await assert.rejects(jev.ask("SHOPPER\nx", { q: { type: "noul", instructions: "?" } }), /cache miss/);
      assert.equal(jev.lookup("0".repeat(64)), undefined);
      jev.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a replay of the same settings matches the source row for row and queues no creative tasks", async () => {
    const db = new FakeDb();
    const settings = { seed: 13, population: 40, roundsPlanned: 1 };
    const original = new Worker({ db, jev: fakeJev(), source: "fixtures", settings, log: quiet });
    for (let round = 0; round <= 1; round++) await original.runRoundTask({ run_id: "run_src", round });
    const replay = new Worker({ db, jev: fakeJev(), source: "fixtures", settings, queueGeneration: false, dayMs: 6, log: quiet });
    for (let round = 0; round <= 1; round++) await replay.runRoundTask({ run_id: "run_src_replay", round });

    const gen = (run_id: string) => db.rows("task").filter((t) => t.kind === "generate_creatives" && t.run_id === run_id);
    assert.equal(gen("run_src").length, 1);
    assert.equal(gen("run_src_replay").length, 0);
    assert.equal(db.rows("run").find((r) => r.run_id === "run_src_replay")?.status, "done");

    const { decisions, rounds, diffs } = await compareRuns(db, "run_src", "run_src_replay");
    assert.deepEqual(diffs, []);
    assert.ok(decisions > 0);
    assert.equal(rounds, 2);
  });

  test("paced days arrive in slices that keep each impression's feed and page rows together", async () => {
    const db = new FakeDb();
    const settings = { seed: 13, population: 40, roundsPlanned: 0 };
    await new Worker({ db, jev: fakeJev(), source: "fixtures", settings, queueGeneration: false, dayMs: 6, log: quiet }).runRoundTask({ run_id: "run_p", round: 0 });
    const inserts = db.calls.filter((c) => c.reducer === "insert_decisions");
    assert.ok(inserts.length > 3, `expected several slices per day, got ${inserts.length}`);
    const rows = db.rows("decision");
    for (let i = 0; i < rows.length; i += 2) {
      assert.equal(rows[i]!.kind, "feed");
      assert.equal(rows[i + 1]!.kind, "page");
      assert.equal(rows[i]!.shopper_id, rows[i + 1]!.shopper_id);
    }
  });

  test("a different seed is not identical", async () => {
    const db = new FakeDb();
    for (const [run_id, seed] of [["run_x", 13], ["run_y", 14]] as const) {
      await new Worker({ db, jev: fakeJev(), source: "fixtures", settings: { seed, population: 40, roundsPlanned: 0 }, queueGeneration: false, log: quiet }).runRoundTask({ run_id, round: 0 });
    }
    assert.notDeepEqual((await compareRuns(db, "run_x", "run_y")).diffs, []);
  });
});

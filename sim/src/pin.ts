import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Offsets, calibrate } from "./calibrate.js";
import { SIM_ROOT, loadEnv } from "./config.js";
import { JevClient, type Questions } from "./jev.js";
import { SpacetimeHttp, type SqlRow, isLocalUri, sqlString } from "./spacetime.js";

// B6: the pinned shopper (docs/PLAN.md "B6", demo beat 3). Finds the shopper whose tap or buy
// chance on the same recipe changed most between rounds for one clear reason, a new shopping flag
// or ad wear-out, and freezes everything the demo shows about them to JSON.
//
// Every decision row's options.state_hash is its Jev cache key, so the exact text Jev read is
// read back from the local cache: nothing is re-simulated. Only reads SpacetimeDB.
//
// Usage: npm run sim:pin -- [--run <run_id>] [--out demo/pinned-shopper.json] [--min-round 1] [--check 80] [--no-verify]

// --- Pure parts (tested in test/b6.test.ts) --------------------------------------------------

// The SHOPPER and MEMORY lines of a feed or page state, without their headings. Both calls show
// these two blocks identically, so they're what changed about the shopper between impressions.
export function stateLines(state: string): string[] {
  return state
    .split("\n\n")
    .filter((b) => b.startsWith("SHOPPER\n") || b.startsWith("MEMORY\n"))
    .flatMap((b) => b.split("\n").slice(1));
}

export type Diff = { removed: string[]; added: string[] };
export type States = { feed: string; page: string };

export function diffStateLines(before: string, after: string): Diff {
  const a = before.split("\n").filter(Boolean);
  const b = after.split("\n").filter(Boolean);
  return { removed: a.filter((l) => !b.includes(l)), added: b.filter((l) => !a.includes(l)) };
}

// The changes across one impression's two calls (feed and page), each line once.
export function diffImpression(before: States, after: States): Diff {
  const f = diffStateLines(before.feed, after.feed);
  const p = diffStateLines(before.page, after.page);
  const uniq = (xs: string[]) => [...new Set(xs)];
  return { removed: uniq([...f.removed, ...p.removed]), added: uniq([...f.added, ...p.added]) };
}

// Replace one exact line (or drop it, with null) everywhere in a state.
export function swapLine(state: string, from: string, to: string | null): string {
  return state
    .split("\n")
    .flatMap((l) => (l === from ? (to === null ? [] : [to]) : [l]))
    .join("\n");
}

export const REORDERED = "(the same lines in a different order)";

// What else differs once the reason line is put back: every line that still differs between the
// "before" states and the reverted "after" states, in any block (the feed's neighbour posts and
// the page's price line move Jev too), or a reorder. None means the line is the only difference.
export function confoundersOf(before: States, after: States, reason: { before: string; after: string }): string[] {
  const reverted = { feed: swapLine(after.feed, reason.after, reason.before), page: swapLine(after.page, reason.after, reason.before) };
  const d = diffImpression(before, reverted);
  const lines = [...d.removed, ...d.added];
  if (!lines.length && (reverted.feed !== before.feed || reverted.page !== before.page)) lines.push(REORDERED);
  return lines;
}

const SHOPPING = /^(Shopping for a new cereal|Not shopping for cereal)/;
// sim/src/render.ts memoryLines: "Has seen {client} ads {once|twice|N times} this week[, mostly about {concept}]."
const SEEN = /^Has seen (.+?) ads (once|twice|\d+ times) this week(?:, mostly about (.+?))?\.$/;
const NEVER_SEEN = /^Has never seen an? (.+?) ad\.$/;

export function parseSeen(line: string): { count: number; about: string | null } | null {
  if (NEVER_SEEN.test(line)) return { count: 0, about: null };
  const m = SEEN.exec(line);
  if (!m) return null;
  const count = m[2] === "once" ? 1 : m[2] === "twice" ? 2 : Number.parseInt(m[2]!, 10);
  return { count, about: m[3] ?? null };
}

export type Reason = { kind: "need" | "wear_out"; before: string; after: string };

// One clear reason per pair: a new shopping flag (need: "Not shopping" became "Shopping for a new
// cereal"), or the client's exposure line went up on the same concept while the tap chance fell
// (wear-out). A flag that ends is left out: B6 and the what-if toggle tell the arrival story.
export function findReason(diff: Diff, tapBefore: number, tapAfter: number): Reason | null {
  const pick = (test: (l: string) => boolean) => [diff.removed.find(test), diff.added.find(test)] as const;
  const [needBefore, needAfter] = pick((l) => SHOPPING.test(l));
  if (needBefore?.startsWith("Not shopping") && needAfter?.startsWith("Shopping")) return { kind: "need", before: needBefore, after: needAfter };
  const [seenBefore, seenAfter] = pick((l) => parseSeen(l) !== null);
  if (seenBefore && seenAfter) {
    const a = parseSeen(seenBefore)!;
    const b = parseSeen(seenAfter)!;
    if (b.count > a.count && a.about !== null && a.about === b.about && tapAfter < tapBefore) {
      return { kind: "wear_out", before: seenBefore, after: seenAfter };
    }
  }
  return null;
}

export type Chances = { tap: number; stay: number; buy: number; guard: 0 | 1 };

// How much the decision moved, on the log scale: the larger of the tap and the buy change. Buy
// counts only when the budget guard allowed a purchase both times.
export function effectSize(before: Chances, after: Chances): number {
  const tap = Math.abs(Math.log(after.tap / before.tap));
  const buy = before.guard && after.guard ? Math.abs(Math.log(after.buy / before.buy)) : 0;
  return Math.max(tap, buy);
}

export type Candidate = { reason: Reason; confounders: string[]; sameCreative: boolean; effect: number };

// The gate the effect comes from: tap, or buy when it moved more (and the guard allowed both).
export function mainGate(before: Chances, after: Chances): "tap" | "buy" {
  const tap = Math.abs(Math.log(after.tap / before.tap));
  const buy = before.guard && after.guard ? Math.abs(Math.log(after.buy / before.buy)) : 0;
  return buy > tap ? "buy" : "tap";
}

// The share of the change the reason line accounts for: put the line back in the "after" state
// and see how far the chance returns toward "before" (1 = all of it, 0 = none), on the log scale.
export function explainedShare(before: number, after: number, reverted: number): number | null {
  const total = Math.log(after / before);
  return Math.abs(total) < 1e-9 ? null : Math.log(after / reverted) / total;
}

// Among verified candidates: the biggest change the line explains most of (at least half),
// else the biggest change.
export function pickPinned<T extends Candidate & { explained: number | null }>(verified: readonly T[]): T | undefined {
  const score = (c: T) => c.effect * Math.min(1, Math.max(0, c.explained ?? 0));
  const clear = verified.filter((c) => (c.explained ?? 0) >= 0.5);
  const pool = clear.length ? clear : verified;
  return [...pool].sort((a, b) => (clear.length ? score(b) - score(a) : b.effect - a.effect))[0];
}

// Fewest confounders first, then the same creative both times, then the biggest change.
export function rankCandidates<T extends Candidate>(cands: readonly T[]): T[] {
  return [...cands].sort(
    (a, b) =>
      a.confounders.length - b.confounders.length ||
      Number(b.sameCreative) - Number(a.sameCreative) ||
      b.effect - a.effect,
  );
}

// --- The capture --------------------------------------------------------------------------------

type Answers = Record<string, { type: string; noul?: number; probabilities?: Record<string, number> }>;

export type CapturedCall = { state_hash: string; state: string; questions: Questions; answers: Answers };
export type CapturedImpression = {
  round: number;
  tick: number;
  arm_id: string;
  creative_id: string;
  headline: string;
  // our_key: our ad's tap question in this feed call (tap_A, tap_B or tap_C).
  feed: CapturedCall & { our_key: string; tap_raw: number; tap_cal: number; draw: number | null; action: string };
  page: CapturedCall & {
    stay_raw: number;
    buy_raw: number;
    stay_cal: number;
    buy_cal: number;
    guard: 0 | 1;
    draw: { stay: number | null; buy: number | null };
    action: string;
    objection: string | null;
  };
};
export type Counterfactual = { tap_cal: number; stay_cal: number; buy_cal: number };

export type PinnedCapture = {
  version: 1;
  run: { run_id: string; seed: number; population: number; config_hash: string; offsets: Offsets };
  shopper: { shopper_id: string; display_name: string; segment_id: string; segment_name: string };
  arm: { arm_id: string; label: string };
  // explained: how much of the change the line accounts for (1 = all); confounders: what else
  // differed between the two impressions.
  reason: Reason & { explained: number | null; confounders: string[] };
  before: CapturedImpression;
  after: CapturedImpression;
  // The "after" states re-asked with the reason line put back to its "before" text, and with it
  // removed (what the /sim what-if toggle does). Null when --no-verify.
  counterfactuals: { reverted: Counterfactual; removed: Counterfactual } | null;
  history: {
    round: number;
    tick: number;
    arm_id: string;
    creative_id: string;
    tap_cal: number;
    stay_cal: number | null;
    buy_cal: number | null;
    action: string;
    page_action: string | null;
    in_market: boolean;
    seen_client: number | null;
  }[];
};

// --- CLI ----------------------------------------------------------------------------------------

const json = <T>(v: unknown): T => JSON.parse(String(v)) as T;

async function main() {
  const { values: args } = parseArgs({
    options: {
      run: { type: "string" },
      out: { type: "string", default: "demo/pinned-shopper.json" },
      "min-round": { type: "string", default: "1" },
      "no-verify": { type: "boolean", default: false },
      // How many of the cleanest pairs get re-asked to confirm their reason (2 Jev calls each the
      // first time, cached after).
      check: { type: "string", default: "80" },
    },
  });
  loadEnv();
  const uri = process.env.SPACETIMEDB_URI ?? "";
  const db = await SpacetimeHttp.connect("sim-pin");
  console.error(`sim pin (read-only) → ${uri} / ${process.env.SPACETIMEDB_DB_NAME} (${isLocalUri(uri) ? "LOCAL" : "MAINCLOUD"})`);

  const runs = await db.sql("SELECT * FROM run");
  const run = args.run ? runs.find((r) => r.run_id === args.run) : [...runs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!run) throw new Error(args.run ? `no run ${args.run}` : "no runs in this database");
  const run_id = String(run.run_id);
  const offsets = json<{ offsets: Offsets }>(run.calibration).offsets;

  const [decisions, creatives, arms, segments, shoppers] = await Promise.all([
    db.sql(`SELECT * FROM decision WHERE run_id = ${sqlString(run_id)}`),
    db.sql("SELECT * FROM creative"),
    db.sql("SELECT * FROM arm"),
    db.sql("SELECT * FROM segment"),
    db.sql(`SELECT * FROM shopper WHERE run_id = ${sqlString(run_id)}`),
  ]);
  const creative = new Map(creatives.map((c) => [String(c.creative_id), c]));
  const armRow = new Map(arms.map((a) => [String(a.arm_id), a]));
  const armLabel = (id: string) => {
    const a = armRow.get(id);
    return !a ? id : a.strategy === "control" ? "Magic Spoon's current ads" : `${String(a.angle).replaceAll("_", " ")} × ${String(a.hook).replaceAll("_", " ")}`;
  };
  const page = new Map(decisions.filter((d) => d.kind === "page").map((d) => [`${d.shopper_id}|${d.tick}`, d]));
  const feed = decisions.filter((d) => d.kind === "feed");
  const armOf = (d: SqlRow) => String(creative.get(String(d.creative_id))?.arm_id ?? "");

  const jev = new JevClient();
  const states = new Map<string, { state: string; questions: Questions; answers: Answers }>();
  const call = (key: string) => {
    let c = states.get(key);
    if (!c) {
      const hit = jev.lookup(key);
      if (!hit) throw new Error(`state ${key.slice(0, 12)} isn't in the local Jev cache; pin from the machine that ran ${run_id}`);
      c = { state: hit.request.state, questions: hit.request.questions, answers: (hit.response as { answers: Answers }).answers };
      states.set(key, c);
    }
    return c;
  };
  const chances = (f: SqlRow): Chances => {
    const p = json<{ stay: number; buy: number; guard: 0 | 1 }>(page.get(`${f.shopper_id}|${f.tick}`)!.p_cal);
    return { tap: json<{ tap: Record<string, number> }>(f.p_cal).tap[String(f.creative_id)]!, stay: p.stay, buy: p.buy, guard: p.guard };
  };

  const hashOf = (d: SqlRow) => json<{ state_hash: string }>(d.options).state_hash;
  const ourKeyOf = (f: SqlRow) => `tap_${"ABC"[(json<{ order?: string[] }>(f.options).order ?? []).indexOf(String(f.creative_id))]}`;
  const pageOf = (f: SqlRow) => page.get(`${f.shopper_id}|${f.tick}`)!;
  const statesOf = (f: SqlRow) => ({ feed: call(hashOf(f)).state, page: call(hashOf(pageOf(f))).state });

  // Same shopper, same arm, different rounds (earlier → later).
  const minRound = Number(args["min-round"]);
  const groups = new Map<string, SqlRow[]>();
  for (const f of feed) {
    if (Number(f.round) < minRound) continue;
    const k = `${f.shopper_id}|${armOf(f)}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  type Found = Candidate & { a: SqlRow; b: SqlRow; ca: Chances; cb: Chances };
  const found: Found[] = [];
  for (const rows of groups.values()) {
    rows.sort((x, y) => Number(x.tick) - Number(y.tick));
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const [a, b] = [rows[i]!, rows[j]!];
        if (a.round === b.round) continue;
        const [ca, cb] = [chances(a), chances(b)];
        const [sa, sb] = [statesOf(a), statesOf(b)];
        const reason = findReason(diffImpression(sa, sb), ca.tap, cb.tap);
        if (!reason) continue;
        const confounders = confoundersOf(sa, sb, reason);
        found.push({ a, b, ca, cb, reason, confounders, sameCreative: a.creative_id === b.creative_id, effect: effectSize(ca, cb) });
      }
    }
  }
  const ranked = rankCandidates(found);
  if (!ranked.length) throw new Error(`no pair in ${run_id} changed for a clear reason (need or wear-out)`);

  // Re-ask the "after" impression with the reason line swapped: put back (how far the chance
  // returns is how much the line explains) or removed (what the /sim what-if does). Through the
  // sqlite cache, so only the first pin of a run makes a few fresh calls.
  const reask = async (c: Found, to: string | null): Promise<Counterfactual> => {
    const f = call(hashOf(c.b));
    const p = call(hashOf(pageOf(c.b)));
    const ourKey = ourKeyOf(c.b);
    const [fa, pa] = await Promise.all([
      jev.ask(swapLine(f.state, c.reason.after, to), f.questions),
      jev.ask(swapLine(p.state, c.reason.after, to), p.questions),
    ]);
    const noul = (x: unknown) => (x as { noul: number }).noul;
    return {
      tap_cal: calibrate(noul(fa.answers[ourKey]), offsets.tap),
      stay_cal: calibrate(noul(pa.answers.stays), offsets.stay),
      buy_cal: c.cb.guard ? calibrate(noul(pa.answers.buys), offsets.buy) : 0,
    };
  };

  type Verified = Found & { explained: number | null; reverted: Counterfactual | null };
  let verified: Verified[];
  if (args["no-verify"]) {
    verified = [{ ...ranked[0]!, explained: null, reverted: null }];
  } else {
    verified = [];
    for (const c of ranked.slice(0, Number(args.check))) {
      const reverted = await reask(c, c.reason.before);
      const explained =
        mainGate(c.ca, c.cb) === "tap" ? explainedShare(c.ca.tap, c.cb.tap, reverted.tap_cal) : explainedShare(c.ca.buy, c.cb.buy, reverted.buy_cal);
      verified.push({ ...c, explained, reverted });
    }
  }
  const top = pickPinned(verified)!;
  const day = (t: unknown) => (Number(t) % Number(run.ticks_per_round)) + 1;
  console.error(`${found.length} pairs changed for a clear reason; checked the ${verified.length} cleanest:`);
  for (const c of verified) {
    console.error(
      `  ${c === top ? "*" : " "} ${c.a.shopper_id} ${armOf(c.a)} R${c.a.round}·D${day(c.a.tick)}→R${c.b.round}·D${day(c.b.tick)} ${c.reason.kind} ` +
        `other changes=${c.confounders.length} same ad=${c.sameCreative} tap ×${(c.cb.tap / c.ca.tap).toFixed(2)} buy ${c.ca.guard && c.cb.guard ? `×${(c.cb.buy / c.ca.buy).toFixed(2)}` : "–"}` +
        (c.explained === null ? "" : ` explained ${(c.explained * 100).toFixed(0)}%`),
    );
  }

  const capture = (f: SqlRow): CapturedImpression => {
    const p = page.get(`${f.shopper_id}|${f.tick}`)!;
    const fk = json<{ state_hash: string }>(f.options).state_hash;
    const pk = json<{ state_hash: string }>(p.options).state_hash;
    const fraw = json<{ tap: Record<string, number> }>(f.p_raw);
    const praw = json<{ stay: number; buy: number }>(p.p_raw);
    const pcal = json<{ stay: number; buy: number; guard: 0 | 1 }>(p.p_cal);
    const pdraw = json<{ stay: number | null; buy: number | null }>(p.draw);
    const c = creative.get(String(f.creative_id));
    return {
      round: Number(f.round),
      tick: Number(f.tick),
      arm_id: armOf(f),
      creative_id: String(f.creative_id),
      headline: String(c?.headline ?? f.creative_id),
      feed: {
        state_hash: fk,
        ...call(fk),
        our_key: ourKeyOf(f),
        tap_raw: fraw.tap[String(f.creative_id)]!,
        tap_cal: json<{ tap: Record<string, number> }>(f.p_cal).tap[String(f.creative_id)]!,
        draw: json<{ tap?: number }>(f.draw).tap ?? null,
        action: String(f.action),
      },
      page: {
        state_hash: pk,
        ...call(pk),
        stay_raw: praw.stay,
        buy_raw: praw.buy,
        stay_cal: pcal.stay,
        buy_cal: pcal.buy,
        guard: pcal.guard,
        draw: { stay: pdraw.stay ?? null, buy: pdraw.buy ?? null },
        action: String(p.action),
        objection: (p.objection as string | null) ?? null,
      },
    };
  };
  const before = capture(top.a);
  const after = capture(top.b);

  const counterfactuals: PinnedCapture["counterfactuals"] = top.reverted ? { reverted: top.reverted, removed: await reask(top, null) } : null;
  const explained = top.explained;

  const shopperRow = shoppers.find((s) => s.shopper_id === top.a.shopper_id);
  const segmentId = String(shopperRow?.segment_id ?? "");
  const history = feed
    .filter((f) => f.shopper_id === top.a.shopper_id)
    .sort((x, y) => Number(x.tick) - Number(y.tick))
    .map((f) => {
      const p = page.get(`${f.shopper_id}|${f.tick}`);
      const pcal = p ? json<{ stay: number; buy: number }>(p.p_cal) : null;
      const lines = stateLines(call(json<{ state_hash: string }>(f.options).state_hash).state);
      const seen = lines.map(parseSeen).find((s) => s !== null) ?? null;
      return {
        round: Number(f.round),
        tick: Number(f.tick),
        arm_id: armOf(f),
        creative_id: String(f.creative_id),
        tap_cal: json<{ tap: Record<string, number> }>(f.p_cal).tap[String(f.creative_id)]!,
        stay_cal: pcal?.stay ?? null,
        buy_cal: pcal?.buy ?? null,
        action: String(f.action),
        page_action: p ? String(p.action) : null,
        in_market: lines.some((l) => l.startsWith("Shopping for a new cereal")),
        seen_client: seen?.count ?? null,
      };
    });

  const out: PinnedCapture = {
    version: 1,
    run: { run_id, seed: Number(run.seed), population: Number(run.population), config_hash: String(run.config_hash), offsets },
    shopper: {
      shopper_id: String(top.a.shopper_id),
      display_name: String(shopperRow?.display_name ?? top.a.shopper_id),
      segment_id: segmentId,
      segment_name: String(segments.find((s) => s.segment_id === segmentId)?.name ?? segmentId),
    },
    arm: { arm_id: armOf(top.a), label: armLabel(armOf(top.a)) },
    reason: { ...top.reason, explained, confounders: top.confounders },
    before,
    after,
    counterfactuals,
    history,
  };
  jev.close();
  const path = resolve(SIM_ROOT, args.out!);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  console.log(`Pinned ${out.shopper.display_name} (${out.shopper.shopper_id}, ${out.shopper.segment_name}) on ${out.arm.label}, ${run_id}`);
  console.log(`  reason (${out.reason.kind}): "${out.reason.before}" → "${out.reason.after}"; other changes: ${out.reason.confounders.length ? out.reason.confounders.join(" | ") : "none"}`);
  for (const [label, imp] of [["before", before], ["after ", after]] as const) {
    console.log(
      `  ${label} round ${imp.round}, day ${(imp.tick % Number(run.ticks_per_round)) + 1}: ${/^["“]/.test(imp.headline) ? imp.headline : `"${imp.headline}"`} tap ${pct(imp.feed.tap_cal)}, stay ${pct(imp.page.stay_cal)}, buy|stay ${pct(imp.page.buy_cal)} → ${imp.feed.action}${imp.page.action !== "not_tapped" ? `, ${imp.page.action}` : ""}`,
    );
  }
  if (counterfactuals) {
    console.log(`  after, line put back: tap ${pct(counterfactuals.reverted.tap_cal)}, buy|stay ${pct(counterfactuals.reverted.buy_cal)}`);
    console.log(`  after, line removed:  tap ${pct(counterfactuals.removed.tap_cal)}, buy|stay ${pct(counterfactuals.removed.buy_cal)}`);
    if (explained !== null) console.log(`  the line explains ${(explained * 100).toFixed(0)}% of the ${mainGate(top.ca, top.cb)} change`);
  }
  console.log(`  wrote ${join("sim", args.out!)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

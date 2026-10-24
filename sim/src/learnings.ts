import type { Bandit } from "./bandit.js";
import { config } from "./config.js";
import type { Arm } from "./contract.js";
import type { Impression } from "./engine.js";
import type { Objection } from "./feed.js";
import type { World } from "./fixtures.js";

// "Reward, bandit and learnings" > "Learnings": written from fixed templates, never by an LLM,
// so every number is traceable. Each learning carries a directive, the same point with every
// number removed; only directives reach the copywriter, so a simulated number can never leak
// into an ad. A learning is keyed by (run, segment, kind, arm or concept); a new version closes
// the old one and nothing is deleted. wear_out is cut (cut line 1; SPIKE.md test 3).

export type LearningKind = "winner" | "objection" | "claim_doubt";

// The contract's learning row. evidence is a json column.
export type Learning = {
  learning_id: string;
  run_id: string;
  segment_id: string;
  arm_id: string | null;
  kind: LearningKind;
  statement: string;
  directive: string;
  evidence: Record<string, unknown>;
  source: "simulated";
  valid_from_round: number;
  valid_to_round: number | null;
};

export type Candidate = Pick<Learning, "segment_id" | "arm_id" | "kind" | "statement" | "directive" | "evidence"> & {
  // What the learning is about within its segment and kind: an arm, a concept, or "top".
  subject: string;
};

// Thresholds from the "Fires when" column.
export const WINNER_P_BEST = 0.8;
export const WINNER_MIN_N = 100;
export const OBJECTION_MIN_CALLS = 50;
export const DOUBT_MAX_BELIEVES = 0.4;
export const DOUBT_MIN_N = 50;

const OBJECTION_WORDS: Record<Exclude<Objection, "nothing">, string> = {
  price: "price",
  taste_doubt: "taste doubts",
  trust: "trust in the brand",
  not_now: "not needing cereal yet",
  other_brand: "loyalty to another brand",
};

const HOOK_WORDS: Record<string, string> = {
  pov_relatable: "relatable point-of-view",
  story_narrative: "story",
  offer_led: "offer-led",
};

const words = (token: string) => token.replaceAll("_", " ");
const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (x: number) => Math.round(x * 100);
const usd = (x: number) => Math.round(x);

// The same sentence with every number removed; throws if a digit survives.
export function numberFree(text: string): string {
  const out = text
    .replace(/\$?\d[\d,.]*%?/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\(\s+/g, "(")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,:;)])/g, "$1")
    .trim();
  if (/\d/.test(out)) throw new Error(`directive still has a number: ${out}`);
  return out;
}

export function costPerOrder(reward: number): number | null {
  return reward > 0 ? config.reward.cpmUsd / 1000 / reward : null;
}

export type LearningInputs = {
  world: World;
  arms: readonly Arm[];
  bandit: Bandit;
  // Every impression of the run so far.
  impressions: readonly Impression[];
  // The concept an ad's main promise is about (its strongest claim), or null.
  mainConcept: (creativeId: string) => string | null;
};

export function findLearnings({ world, arms, bandit, impressions, mainConcept }: LearningInputs): Candidate[] {
  const client = world.brands.find((b) => b.is_client)!;
  const control = arms.find((a) => a.strategy === "control");
  const conceptLabel = new Map(world.concepts.map((c) => [c.key, c.label]));
  const out: Candidate[] = [];

  for (const seg of world.segments) {
    const who = `${seg.name.toLowerCase()} shoppers`;
    const Who = capitalize(who);
    const mine = impressions.filter((i) => i.segment_id === seg.segment_id);

    // winner: p_best ≥ 0.8 and n ≥ 100. The control is the comparison, not a recipe to keep.
    const pBest = bandit.pBestFor(seg.segment_id);
    const controlCpo = control ? costPerOrder(bandit.posterior(seg.segment_id, control.arm_id).mean) : null;
    for (const arm of arms) {
      if (arm.strategy === "control" || !arm.angle || !arm.hook) continue;
      const post = bandit.posterior(seg.segment_id, arm.arm_id);
      const p = pBest[arm.arm_id] ?? 0;
      const cpo = costPerOrder(post.mean);
      if (p < WINNER_P_BEST || post.n < WINNER_MIN_N || cpo === null) continue;
      const angle = words(arm.angle);
      const hook = HOOK_WORDS[arm.hook] ?? words(arm.hook);
      const vsControl = controlCpo === null ? "" : ` vs $${usd(controlCpo)} for ${client.name}'s current ads`;
      out.push({
        segment_id: seg.segment_id,
        arm_id: arm.arm_id,
        kind: "winner",
        subject: arm.arm_id,
        statement: `For ${who}, ${angle} × ${hook} leads: about $${usd(cpo)} per order${vsControl} (${pct(p)}% chance it's truly best).`,
        directive: numberFree(`For ${who}, keep leading with ${angle} through ${article(hook)} ${hook} hook.`),
        evidence: { n: post.n, p_best: p, post_mean: post.mean, post_sd: post.sd, cpo_usd: cpo, cpo_control_usd: controlCpo },
      });
    }

    // objection: ≥ 50 page calls for the segment. The most common hesitation other than
    // "nothing", as a share of all of the segment's page calls.
    if (mine.length >= OBJECTION_MIN_CALLS) {
      const counts = new Map<Exclude<Objection, "nothing">, number>();
      for (const i of mine) if (i.objection !== "nothing") counts.set(i.objection, (counts.get(i.objection) ?? 0) + 1);
      const order = Object.keys(OBJECTION_WORDS) as Exclude<Objection, "nothing">[];
      const top = order.reduce<Exclude<Objection, "nothing"> | null>(
        (best, k) => ((counts.get(k) ?? 0) > (best ? counts.get(best) ?? 0 : 0) ? k : best),
        null,
      );
      if (top) {
        const share = counts.get(top)! / mine.length;
        const label = OBJECTION_WORDS[top];
        out.push({
          segment_id: seg.segment_id,
          arm_id: null,
          kind: "objection",
          subject: "top",
          statement: `${Who} mostly hesitate over ${label} (${pct(share)}% of page visits).`,
          directive: numberFree(`Address ${label} early for ${who}.`),
          evidence: { objection: top, share, page_calls: mine.length },
        });
      }
    }

    // claim_doubt: mean believes < 0.40 over ≥ 50 feed calls, grouped by the concept of each
    // ad's main promise.
    const byConcept = new Map<string, number[]>();
    for (const i of mine) {
      const k = mainConcept(i.creative_id);
      if (k) byConcept.set(k, [...(byConcept.get(k) ?? []), i.believes]);
    }
    for (const [concept, bs] of [...byConcept].sort(([a], [b]) => a.localeCompare(b))) {
      const mean = bs.reduce((a, b) => a + b, 0) / bs.length;
      if (bs.length < DOUBT_MIN_N || mean >= DOUBT_MAX_BELIEVES) continue;
      const label = conceptLabel.get(concept) ?? words(concept);
      out.push({
        segment_id: seg.segment_id,
        arm_id: null,
        kind: "claim_doubt",
        subject: concept,
        statement: `${Who} don't believe ${label} claims (only ${pct(mean)}% do).`,
        directive: numberFree(`${Who} doubt ${label} claims: back them with a concrete brand fact or drop them.`),
        evidence: { concept, mean_believes: mean, n: bs.length },
      });
    }
  }
  return out;
}

// Versioned learnings for one run.
export class LearningBook {
  readonly all: Learning[] = [];
  private byKey = new Map<string, Learning[]>();

  constructor(readonly run_id: string) {}

  live(): Learning[] {
    return this.all.filter((l) => l.valid_to_round === null);
  }

  // End of a round. A new key opens version 1; a changed statement closes the live version and
  // opens the next; a key that no longer fires is closed. valid_from_round is the round whose
  // data produced the learning; valid_to_round is the round at whose end it stopped holding.
  apply(round: number, candidates: readonly Candidate[]): { opened: Learning[]; closed: Learning[] } {
    const opened: Learning[] = [];
    const closed: Learning[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      const key = `${c.segment_id}|${c.kind}|${c.subject}`;
      seen.add(key);
      const versions = this.byKey.get(key) ?? [];
      const current = versions.at(-1);
      if (current && current.valid_to_round === null && current.statement === c.statement) continue;
      if (current && current.valid_to_round === null) {
        current.valid_to_round = round;
        closed.push(current);
      }
      const learning: Learning = {
        learning_id: `lrn_${c.segment_id.replace(/^seg_/, "")}_${c.kind}_${c.subject.replace(/^arm_/, "")}_v${versions.length + 1}`,
        run_id: this.run_id,
        segment_id: c.segment_id,
        arm_id: c.arm_id,
        kind: c.kind,
        statement: c.statement,
        directive: c.directive,
        evidence: c.evidence,
        source: "simulated",
        valid_from_round: round,
        valid_to_round: null,
      };
      this.byKey.set(key, [...versions, learning]);
      this.all.push(learning);
      opened.push(learning);
    }
    for (const [key, versions] of this.byKey) {
      const current = versions.at(-1)!;
      if (!seen.has(key) && current.valid_to_round === null) {
        current.valid_to_round = round;
        closed.push(current);
      }
    }
    return { opened, closed };
  }
}

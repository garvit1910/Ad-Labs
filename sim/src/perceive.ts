import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import type { Creative } from "./contract.js";
import type { World } from "./fixtures.js";

// Perception: what each creative claims, worked out once and frozen (ShopSim rule 6). The
// result has the creative_perception row's shape. Jev takes no images, so this stays a
// pre-step outside Jev.
//
// The provider is pluggable (DECISIONS D35). The plan names Claude; until that is settled,
// the default is a keyword reader over the ad's text. A provider's id is part of the input
// hash, so switching providers re-perceives every creative instead of mixing answers.

export type Perception = {
  creative_id: string;
  // concept key -> strength 0..1
  claims: Record<string, number>;
  offer_pct: number;
  input_hash: string;
};

export interface Perceiver {
  // Bump the version whenever the provider's output can change.
  readonly id: string;
  perceive(creative: Creative, world: World): Promise<Omit<Perception, "creative_id" | "input_hash">>;
}

// A concept counts as claimed (for memory, preference updates and the preference line) at
// this strength or above.
export const CLAIM_MIN = 0.5;

export function claimedConcepts(p: Perception | undefined): string[] {
  if (!p) return [];
  return Object.entries(p.claims)
    .filter(([k, s]) => k !== "other" && s >= CLAIM_MIN)
    .sort(([ka, a], [kb, b]) => b - a || ka.localeCompare(kb))
    .map(([k]) => k);
}

export function inputHash(perceiverId: string, creative: Creative, world: World): string {
  const fields = [creative.headline, creative.primary_text, creative.cta, creative.visual_description, creative.image_url];
  const vocabulary = world.concepts.map((c) => c.key);
  return createHash("sha256").update(JSON.stringify([perceiverId, fields, vocabulary])).digest("hex");
}

// Strength by where the words appear: the headline is the loudest claim, the image the
// quietest.
const FIELD_STRENGTH = { headline: 0.9, primary_text: 0.7, visual_description: 0.5 } as const;

const KEYWORDS: Record<string, RegExp> = {
  high_protein: /\bprotein\b/,
  low_sugar: /\b(zero|0g|no added|low|less) sugar\b|\bsugar crash\b|\blow in sugar\b/,
  low_carb_keto: /\bketo\b|\blow[- ]carb\b|\bcarbs?\b/,
  taste: /\btast(e|es|y|ing)\b|\bbest-tasting\b|\bdelicious\b|\bbig flavor\b|\bdessert\b/,
  nostalgia: /\bgrew up\b|\bchildhood\b|\bremember\b|\bsaturday morning\b|\bcartoons\b|\bbrings back\b/,
  crunch_texture: /\bcrunch(y|es)?\b/,
  flavor_variety: /\bvariety\b|\bflavors\b/,
  clean_ingredients: /\bingredients\b|\bnothing to hide\b|\bclean\b/,
  gluten_grain_free: /\bgrain[- ]free\b|\bno grains\b|\bgluten\b/,
  keeps_full: /\b(keeps? you|stay|stays) full\b|\bfull until\b|\bfilling\b/,
  fitness: /\btrain(ing)?\b|\bgym\b|\bathlete\b|\bworkout\b|\brunning gear\b/,
  weight_goals: /\bweight\b|\bmacros\b|\bcalories?\b/,
  kid_friendly: /\bkids?\b|\bfamily\b|\bchildren\b/,
  convenience: /\bdelivered\b|\bon your schedule\b|\bstore runs?\b|\bsnack(ing)?\b|\bstraight from the (box|bag)\b/,
  value_price: /\bfor less\b|\bsave\b|\bvalue\b|\baffordable\b/,
  discount_offer: /\bdiscount\b|\d+% off\b|\bfirst[- ]order\b|\bsale\b|\bpromo\b/,
  subscription: /\bsubscri(be|ption)\b|\bcancel anytime\b|\bon your schedule\b/,
  social_proof: /\breviews?\b|\bcustomers?\b|\bcult following\b|\bfive-star\b|\bfan notes\b/,
};

// Deterministic stand-in until the plan's model-based perception is wired in. Brand names
// are removed first, so "Catalina Crunch" never claims crunch.
export const keywordPerceiver: Perceiver = {
  id: "keyword-v1",
  async perceive(creative, world) {
    const known = new Set(world.concepts.map((c) => c.key));
    const brandNames = world.brands.map((b) => b.name.toLowerCase());
    const claims: Record<string, number> = {};
    for (const [field, strength] of Object.entries(FIELD_STRENGTH)) {
      let text = creative[field as keyof typeof FIELD_STRENGTH].toLowerCase();
      for (const name of brandNames) text = text.replaceAll(name, " ");
      for (const [key, re] of Object.entries(KEYWORDS)) {
        if (known.has(key) && re.test(text)) claims[key] = Math.max(claims[key] ?? 0, strength);
      }
    }
    const pct = /(\d{1,2})% off\b/.exec(`${creative.headline} ${creative.primary_text}`.toLowerCase());
    return { claims, offer_pct: pct ? Number(pct[1]) / 100 : 0 };
  },
};

// Frozen results, keyed by input hash, in the same SQLite file as the Jev cache.
export class PerceptionStore {
  private db: Database.Database;
  private getStmt: Database.Statement<[string], { claims: string; offer_pct: number }>;
  private putStmt: Database.Statement<[string, string, string, number]>;

  constructor(path: string = config.paths.cacheDb) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS creative_perception (
      input_hash TEXT PRIMARY KEY,
      creative_id TEXT NOT NULL,
      claims TEXT NOT NULL,
      offer_pct REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.getStmt = this.db.prepare("SELECT claims, offer_pct FROM creative_perception WHERE input_hash = ?");
    this.putStmt = this.db.prepare(
      "INSERT OR IGNORE INTO creative_perception (input_hash, creative_id, claims, offer_pct) VALUES (?, ?, ?, ?)",
    );
  }

  get(hash: string): { claims: Record<string, number>; offer_pct: number } | undefined {
    const row = this.getStmt.get(hash);
    return row ? { claims: JSON.parse(row.claims), offer_pct: row.offer_pct } : undefined;
  }

  put(p: Perception): void {
    this.putStmt.run(p.input_hash, p.creative_id, JSON.stringify(p.claims), p.offer_pct);
  }

  close(): void {
    this.db.close();
  }
}

// Perceives every creative once; stored results are returned as they were first written.
// With store = null nothing is persisted (tests).
export async function perceiveAll(
  world: World,
  perceiver: Perceiver = keywordPerceiver,
  store: PerceptionStore | null = null,
): Promise<Map<string, Perception>> {
  const known = new Set(world.concepts.map((c) => c.key));
  const out = new Map<string, Perception>();
  for (const creative of world.creatives) {
    const input_hash = inputHash(perceiver.id, creative, world);
    let result = store?.get(input_hash);
    if (!result) {
      const raw = await perceiver.perceive(creative, world);
      // Unknown concept names map to "other"; strengths and offers are clamped (ShopSim's
      // perception schema).
      const claims: Record<string, number> = {};
      for (const [k, s] of Object.entries(raw.claims)) {
        const key = known.has(k) ? k : "other";
        claims[key] = Math.max(claims[key] ?? 0, Math.min(1, Math.max(0, s)));
      }
      result = { claims, offer_pct: Math.min(0.95, Math.max(0, raw.offer_pct)) };
      store?.put({ creative_id: creative.creative_id, input_hash, ...result });
    }
    out.set(creative.creative_id, { creative_id: creative.creative_id, input_hash, ...result });
  }
  return out;
}

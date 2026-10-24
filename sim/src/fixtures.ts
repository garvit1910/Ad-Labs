import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "./config.js";
import {
  type Arm,
  type Brand,
  type Concept,
  type Creative,
  type Product,
  type Segment,
  armSchema,
  brandSchema,
  conceptSchema,
  creativeSchema,
  productSchema,
  segmentSchema,
} from "./contract.js";

export type World = {
  brands: Brand[];
  concepts: Concept[];
  segments: Segment[];
  products: Product[];
  arms: Arm[];
  creatives: Creative[];
};

function readTable<T extends z.ZodTypeAny>(dir: string, file: string, schema: T): z.output<T>[] {
  const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const parsed = z.array(schema).safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const SHARE_TOLERANCE = 1e-6;

// Cross-table rules from "The contract" that a per-row schema can't see.
export function checkWorld(w: World): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = <T>(rows: T[], key: keyof T) => new Set(rows.map((r) => String(r[key])));
  const dupes = <T>(rows: T[], key: keyof T, table: string) => {
    const seen = new Set<string>();
    for (const r of rows) {
      const id = String(r[key]);
      if (seen.has(id)) errors.push(`${table}: duplicate ${String(key)} ${id}`);
      seen.add(id);
    }
  };
  dupes(w.brands, "brand_id", "brand");
  dupes(w.concepts, "key", "concept");
  dupes(w.segments, "segment_id", "segment");
  dupes(w.products, "product_id", "product");
  dupes(w.arms, "arm_id", "arm");
  dupes(w.creatives, "creative_id", "creative");

  const brandIds = ids(w.brands, "brand_id");
  const conceptKeys = ids(w.concepts, "key");
  const segmentIds = ids(w.segments, "segment_id");
  const armIds = ids(w.arms, "arm_id");

  const clients = w.brands.filter((b) => b.is_client);
  if (clients.length !== 1) errors.push(`brand: expected exactly one client, found ${clients.length}`);
  const clientId = clients[0]?.brand_id;

  const shareSum = w.segments.reduce((s, x) => s + x.share, 0);
  if (Math.abs(shareSum - 1) > SHARE_TOLERANCE) errors.push(`segment: shares sum to ${shareSum}, not 1`);
  for (const s of w.segments) {
    for (const k of Object.keys(s.prior_weights)) {
      if (!conceptKeys.has(k)) errors.push(`segment ${s.segment_id}: prior weight for unknown concept ${k}`);
    }
    const missing = [...conceptKeys].filter((k) => !(k in s.prior_weights));
    if (missing.length) warnings.push(`segment ${s.segment_id}: no prior for ${missing.join(", ")} (treated as unheld)`);
  }

  const controls = w.arms.filter((a) => a.strategy === "control");
  if (controls.length !== 1) errors.push(`arm: expected exactly one control arm, found ${controls.length}`);
  const recipes = w.arms.filter((a) => a.strategy !== "control");
  if (recipes.length < 10 || recipes.length > 12) warnings.push(`arm: ${recipes.length} recipes, plan says 10-12`);
  const anglesHooks = new Set<string>();
  for (const a of recipes) {
    const pair = `${a.angle}|${a.hook}`;
    if (anglesHooks.has(pair)) errors.push(`arm ${a.arm_id}: recipes sharing angle ${a.angle} must use different hooks`);
    anglesHooks.add(pair);
  }

  for (const p of w.products) {
    if (!brandIds.has(p.brand_id)) errors.push(`product ${p.product_id}: unknown brand ${p.brand_id}`);
    if (p.price_usd === 0) warnings.push(`product ${p.product_id}: price not filled in yet`);
  }

  for (const c of w.creatives) {
    const where = `creative ${c.creative_id}`;
    if (!brandIds.has(c.brand_id)) errors.push(`${where}: unknown brand ${c.brand_id}`);
    if (c.landing_product_id) {
      const product = w.products.find((p) => p.product_id === c.landing_product_id);
      if (!product) errors.push(`${where}: unknown product ${c.landing_product_id}`);
      else if (product.brand_id !== c.brand_id) errors.push(`${where}: lands on another brand's product`);
    }
    if (c.segment_id && !segmentIds.has(c.segment_id)) errors.push(`${where}: unknown segment ${c.segment_id}`);
    if (c.arm_id && !armIds.has(c.arm_id)) errors.push(`${where}: unknown arm ${c.arm_id}`);
    const isClient = c.brand_id === clientId;
    switch (c.origin) {
      case "competitor_live":
        if (isClient) errors.push(`${where}: competitor_live ad from the client brand`);
        if (c.arm_id) errors.push(`${where}: competitor ads have no arm`);
        if (c.segment_id) errors.push(`${where}: live ads have no segment`);
        break;
      case "brand_live":
        if (!isClient) errors.push(`${where}: brand_live ad from a competitor`);
        if (c.arm_id !== controls[0]?.arm_id) errors.push(`${where}: brand_live ads belong to the control arm`);
        if (c.segment_id) errors.push(`${where}: live ads have no segment`);
        break;
      case "generated":
        if (!isClient) errors.push(`${where}: generated ad from a competitor`);
        if (!c.arm_id) errors.push(`${where}: generated ads need an arm`);
        if (!c.segment_id) errors.push(`${where}: generated ads need the segment they were written for`);
        break;
    }
  }
  const creativeIds = ids(w.creatives, "creative_id");
  for (const a of w.arms) {
    for (const e of a.evidence) {
      if (e.startsWith("cr_") && !creativeIds.has(e)) errors.push(`arm ${a.arm_id}: evidence cites unknown ad ${e}`);
    }
    if (!w.creatives.some((c) => c.arm_id === a.arm_id && c.status === "ranked")) {
      warnings.push(`arm ${a.arm_id}: no ranked creative`);
    }
  }
  for (const b of w.brands) {
    const live = w.creatives.filter((c) => c.brand_id === b.brand_id && c.origin !== "generated").length;
    if (live < 2) warnings.push(`brand ${b.brand_id}: ${live} live ads, B0 asks for at least 2`);
    if (!w.products.some((p) => p.brand_id === b.brand_id)) warnings.push(`brand ${b.brand_id}: no product`);
  }
  return { errors, warnings };
}

export function loadWorld(dir: string = config.paths.fixtures): World {
  const world: World = {
    brands: readTable(dir, "brands.json", brandSchema),
    concepts: readTable(dir, "concepts.json", conceptSchema),
    segments: readTable(dir, "segments.json", segmentSchema),
    products: readTable(dir, "products.json", productSchema),
    arms: readTable(dir, "arms.json", armSchema),
    creatives: readTable(dir, "creatives.json", creativeSchema),
  };
  const { errors, warnings } = checkWorld(world);
  for (const w of warnings) console.warn(`fixtures warning: ${w}`);
  if (errors.length) throw new Error(`fixtures invalid:\n  ${errors.join("\n  ")}`);
  return world;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const w = loadWorld();
  console.log(
    `fixtures ok: ${w.brands.length} brands, ${w.concepts.length} concepts, ${w.segments.length} segments, ` +
      `${w.products.length} products, ${w.arms.length} arms, ${w.creatives.length} creatives`,
  );
}

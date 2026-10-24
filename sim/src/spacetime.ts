import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import {
  armSchema,
  brandSchema,
  conceptSchema,
  creativeSchema,
  productSchema,
  segmentSchema,
} from "./contract.js";
import type { DayResult } from "./engine.js";
import { type World, checkWorld } from "./fixtures.js";
import type { Learning } from "./learnings.js";
import type { Perception } from "./perceive.js";
import type { Shopper } from "./population.js";
import type { ArmStat, GenerationRequest } from "./run.js";

// SpacetimeDB over its HTTP API (docs: spacetimedb.com/docs/http/database):
//   POST /v1/identity                          -> { identity, token } for this worker
//   POST /v1/database/<db>/call/<reducer>      body: the reducer's arguments as a JSON array
//   POST /v1/database/<db>/sql                 body: SQL text; -> [{ schema, rows }] in SATS-JSON
// Plain fetch, no SDK (D62), the same way A's check:connections reaches the database. Reducer
// names on the wire are the snake_case of the module's export names (upsertProducts ->
// upsert_products).

export type SqlRow = Record<string, unknown>;

export interface Db {
  call(reducer: string, args: unknown[]): Promise<void>;
  sql(query: string): Promise<SqlRow[]>;
  // Who claims tasks (the task row's claimed_by).
  readonly name: string;
}

export class SpacetimeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 30_000;

// SATS-JSON (spacetimedb.com/docs/sats-json): a product is an array in element order (or an
// object by field name); a sum is a one-key object whose key is the variant's index or name.
// Options are sums of some/none; timestamps are a product holding microseconds since the epoch.
type AlgebraicType = Record<string, unknown>;
type Element = { name?: { some?: string } | null; algebraic_type: AlgebraicType };

function variantName(v: unknown): string | undefined {
  const n = (v as { name?: { some?: string } } | undefined)?.name;
  return n?.some;
}

export function decodeValue(type: AlgebraicType, value: unknown): unknown {
  if ("Product" in type) {
    const elements = ((type.Product as { elements: Element[] }).elements ?? []) as Element[];
    const names = elements.map((e) => e.name?.some ?? "");
    // Timestamp: { __timestamp_micros_since_unix_epoch__: i64 } -> ISO string.
    if (names.length === 1 && names[0] === "__timestamp_micros_since_unix_epoch__") {
      const micros = Array.isArray(value) ? value[0] : (value as Record<string, unknown>)[names[0]];
      return new Date(Number(micros) / 1000).toISOString();
    }
    if (names.length === 1 && names[0]?.startsWith("__") && names[0].endsWith("__")) {
      return Array.isArray(value) ? value[0] : (value as Record<string, unknown>)[names[0]];
    }
    const out: Record<string, unknown> = {};
    elements.forEach((e, i) => {
      const raw = Array.isArray(value) ? value[i] : (value as Record<string, unknown>)[names[i]!];
      out[names[i]!] = decodeValue(e.algebraic_type, raw);
    });
    return out;
  }
  if ("Sum" in type) {
    const variants = ((type.Sum as { variants: unknown[] }).variants ?? []) as { algebraic_type: AlgebraicType }[];
    const isOption = variants.length === 2 && variantName(variants[0]) === "some" && variantName(variants[1]) === "none";
    const [key, inner] = Object.entries(value as Record<string, unknown>)[0] ?? [];
    const index = key !== undefined && /^\d+$/.test(key) ? Number(key) : variants.findIndex((v) => variantName(v) === key);
    if (isOption) return index === 0 ? decodeValue(variants[0]!.algebraic_type, inner) : null;
    const variant = variants[index];
    return { [variantName(variant) ?? String(index)]: variant ? decodeValue(variant.algebraic_type, inner) : inner };
  }
  if ("Array" in type) return (value as unknown[]).map((v) => decodeValue(type.Array as AlgebraicType, v));
  // Integers arrive as JSON numbers (the docs: above 2^52 they lose precision; ours are small).
  return value;
}

export function decodeRows(result: { schema: AlgebraicType; rows: unknown[] }): SqlRow[] {
  const productType = "Product" in result.schema ? result.schema : { Product: result.schema };
  return result.rows.map((r) => decodeValue(productType, r) as SqlRow);
}

export const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

// A localhost server is the B5 test bench; anything else (Maincloud) is the shared database.
export function isLocalUri(uri: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
}

// One identity token per server: a token minted by Maincloud isn't valid on the local bench, and the
// other way round (DECISIONS D75). The Maincloud file keeps its pre-B5 name.
export function identityPath(uri: string): string {
  const host = new URL(uri).host;
  if (host === "maincloud.spacetimedb.com") return config.paths.spacetimeIdentity;
  return config.paths.spacetimeIdentity.replace(/\.json$/, `.${host.replace(/[^a-z0-9.-]/gi, "_")}.json`);
}

export class SpacetimeHttp implements Db {
  private token: string | null;
  readonly name: string;

  constructor(
    private uri: string,
    private db: string,
    opts: { token?: string | null; name?: string } = {},
  ) {
    this.uri = uri.replace(/\/$/, "");
    this.token = opts.token ?? null;
    this.name = opts.name ?? "sim-worker";
  }

  // The worker's identity token is kept in .cache (git-ignored), one per server, so it claims
  // tasks as the same identity across restarts.
  static async connect(name = "sim-worker"): Promise<SpacetimeHttp> {
    const uri = process.env.SPACETIMEDB_URI?.trim();
    const db = process.env.SPACETIMEDB_DB_NAME?.trim();
    if (!uri || !db) throw new SpacetimeError("SPACETIMEDB_URI and SPACETIMEDB_DB_NAME must be set in .env.local");
    const path = identityPath(uri);
    let token: string | null = null;
    let identity = "";
    if (existsSync(path)) ({ token, identity } = JSON.parse(readFileSync(path, "utf8")));
    if (!token) {
      const res = await fetch(`${uri.replace(/\/$/, "")}/v1/identity`, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new SpacetimeError(`POST /v1/identity: HTTP ${res.status}`, res.status);
      ({ token, identity } = (await res.json()) as { token: string; identity: string });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ token, identity }));
    }
    return new SpacetimeHttp(uri, db, { token, name: `${name}:${identity.slice(0, 12)}` });
  }

  private headers(contentType: string): Record<string, string> {
    return { "Content-Type": contentType, ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
  }

  async call(reducer: string, args: unknown[]): Promise<void> {
    const res = await fetch(`${this.uri}/v1/database/${this.db}/call/${reducer}`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new SpacetimeError(`${reducer}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  }

  async sql(query: string): Promise<SqlRow[]> {
    const res = await fetch(`${this.uri}/v1/database/${this.db}/sql`, {
      method: "POST",
      headers: this.headers("text/plain"),
      body: query,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new SpacetimeError(`sql: HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    const results = JSON.parse(text) as { schema: AlgebraicType; rows: unknown[] }[];
    return results.flatMap(decodeRows);
  }
}

// --- Reading A's rows -------------------------------------------------------------------------

function parseTable<T extends z.ZodTypeAny>(table: string, rows: SqlRow[], schema: T): z.output<T>[] {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) throw new SpacetimeError(`${table}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// The world as of a round: A's brand, concept, segment, arm and creative rows, plus B's product
// rows. Creatives written for a later round are left out, so replaying an earlier round sees what
// it saw then. Rows go through the same contract schemas and cross-table checks as the fixtures.
export async function loadWorldFromDb(db: Db, round: number): Promise<World> {
  const read = (table: string) => db.sql(`SELECT * FROM ${table}`);
  const [brands, concepts, segments, products, arms, creatives] = await Promise.all(
    ["brand", "concept", "segment", "product", "arm", "creative"].map(read),
  );
  const world: World = {
    brands: parseTable("brand", brands!, brandSchema),
    concepts: parseTable("concept", concepts!, conceptSchema),
    segments: parseTable("segment", segments!, segmentSchema),
    products: parseTable("product", products!, productSchema),
    arms: parseTable("arm", arms!, armSchema),
    creatives: parseTable("creative", creatives!, creativeSchema).filter((c) => c.round_created <= round),
  };
  // Row order from SQL isn't guaranteed; the fixture order is by id, and draws index into it.
  const byId = <T>(rows: T[], key: keyof T) => rows.sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  byId(world.brands, "brand_id");
  byId(world.concepts, "key");
  byId(world.segments, "segment_id");
  byId(world.products, "product_id");
  byId(world.arms, "arm_id");
  byId(world.creatives, "creative_id");
  const { errors, warnings } = checkWorld(world);
  for (const w of warnings) console.warn(`spacetime rows warning: ${w}`);
  if (errors.length) throw new SpacetimeError(`A's rows are invalid:\n  ${errors.join("\n  ")}`);
  return world;
}

// --- Writing B's rows (one reducer call per table per sim day) ---------------------------------

export const writer = {
  products: (db: Db, world: World) => db.call("upsert_products", [JSON.stringify(world.products)]),

  perceptions: (db: Db, perceptions: Map<string, Perception>) =>
    db.call("upsert_creative_perceptions", [JSON.stringify([...perceptions.values()])]),

  run: (db: Db, row: Record<string, unknown>) => db.call("upsert_run", [JSON.stringify(row)]),

  startRound: (db: Db, run_id: string, round: number) => db.call("start_round", [run_id, round]),

  finishRound: (db: Db, run_id: string, round: number, status: string, summary: unknown) =>
    db.call("finish_round", [run_id, round, status, JSON.stringify(summary)]),

  // End of a sim day: decisions, shoppers and the refreshed arm stats, one call each.
  async day(db: Db, run_id: string, day: DayResult, shoppers: readonly Shopper[], stateText: (id: string) => string, armStats: ArmStat[]) {
    await db.call("insert_decisions", [JSON.stringify(day.decisions)]);
    const rows = shoppers.map((s) => ({
      shopper_id: s.shopper_id,
      segment_id: s.segment_id,
      display_name: s.display_name,
      in_market: s.in_market,
      budget_left_usd: s.budget_left_usd,
      state_text: stateText(s.shopper_id),
    }));
    await db.call("upsert_shoppers", [run_id, JSON.stringify(rows)]);
    await db.call("replace_arm_stats", [run_id, day.round, JSON.stringify(armStats)]);
  },

  learnings: (db: Db, learnings: Learning[]) =>
    learnings.length ? db.call("upsert_learnings", [JSON.stringify(learnings)]) : Promise.resolve(),

  enqueue: (db: Db, task_id: string, kind: "run_round" | "generate_creatives", payload: object) =>
    db.call("enqueue_task", [task_id, kind, JSON.stringify(payload)]),

  generation: (db: Db, g: GenerationRequest) => writer.enqueue(db, `tsk_gen_${g.run_id}_r${g.round}`, "generate_creatives", g),
};

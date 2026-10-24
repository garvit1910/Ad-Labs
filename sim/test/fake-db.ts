import { type Db, SpacetimeError, type SqlRow } from "../src/spacetime.js";

// An in-memory stand-in for the SpacetimeDB module, for worker tests without the network. Each
// reducer follows the same rules as spacetime/src/reducers_b.ts (upsert keys, frozen
// perceptions, the claim check), and rows come back the way the HTTP SQL endpoint decodes them:
// options as null, timestamps as ISO strings, json columns as JSON text.
export class FakeDb implements Db {
  readonly tables = new Map<string, SqlRow[]>();
  calls: { reducer: string; bytes: number }[] = [];
  private clock = Date.parse("2026-10-24T14:30:00Z");

  constructor(readonly name = "test-worker") {}

  rows(table: string): SqlRow[] {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = []));
    return t;
  }

  private now(): string {
    return new Date((this.clock += 1000)).toISOString();
  }

  private upsert(table: string, key: (r: SqlRow) => string, row: SqlRow): void {
    const t = this.rows(table);
    const i = t.findIndex((r) => key(r) === key(row));
    if (i >= 0) t[i] = row;
    else t.push(row);
  }

  async sql(query: string): Promise<SqlRow[]> {
    const m = /^SELECT \* FROM (\w+)(?: WHERE (\w+) = '((?:[^']|'')*)')?$/.exec(query.trim());
    if (!m) throw new SpacetimeError(`fake sql: unsupported query ${query}`);
    const [, table, col, value] = m;
    const rows = this.rows(table!);
    const out = col ? rows.filter((r) => String(r[col]) === value!.replaceAll("''", "'")) : rows;
    return structuredClone(out);
  }

  async call(reducer: string, args: unknown[]): Promise<void> {
    this.calls.push({ reducer, bytes: JSON.stringify(args).length });
    const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
    const nul = (v: unknown) => (v === undefined || v === "" ? null : v);
    const list = (i: number) => JSON.parse(args[i] as string) as SqlRow[];
    switch (reducer) {
      case "upsert_products":
        for (const r of list(0)) this.upsert("product", (x) => String(x.product_id), { ...r, subscription_price_usd: nul(r.subscription_price_usd), page_highlights: json(r.page_highlights) });
        return;
      case "upsert_creative_perceptions":
        for (const r of list(0)) {
          const old = this.rows("creative_perception").find((x) => x.creative_id === r.creative_id);
          if (!old || old.input_hash !== r.input_hash) this.upsert("creative_perception", (x) => String(x.creative_id), { ...r, claims: json(r.claims) });
        }
        return;
      case "upsert_run": {
        const r = JSON.parse(args[0] as string) as SqlRow;
        const old = this.rows("run").find((x) => x.run_id === r.run_id);
        this.upsert("run", (x) => String(x.run_id), { ...r, calibration: json(r.calibration), created_at: old?.created_at ?? this.now() });
        return;
      }
      case "start_round": {
        const [run_id, round] = args as [string, number];
        this.tables.set("round", this.rows("round").filter((x) => !(x.run_id === run_id && x.round === round)));
        this.rows("round").push({ run_id, round, status: "running", started_at: this.now(), finished_at: null, summary: "{}" });
        return;
      }
      case "finish_round": {
        const [run_id, round, status, summary] = args as [string, number, string, string];
        const old = this.rows("round").find((x) => x.run_id === run_id && x.round === round);
        this.tables.set("round", this.rows("round").filter((x) => x !== old));
        this.rows("round").push({ run_id, round, status, started_at: old?.started_at ?? null, finished_at: this.now(), summary });
        return;
      }
      case "upsert_shoppers": {
        const run_id = args[0] as string;
        const batch = list(1).map((r): SqlRow => ({ run_id, ...r }));
        const ids = new Set(batch.map((r) => r.shopper_id));
        this.tables.set("shopper", this.rows("shopper").filter((x) => !(x.run_id === run_id && ids.has(x.shopper_id))));
        this.rows("shopper").push(...batch);
        return;
      }
      case "insert_decisions":
        for (const r of list(0)) {
          this.rows("decision").push({
            ...r,
            options: json(r.options),
            p_raw: json(r.p_raw),
            p_cal: json(r.p_cal),
            draw: json(r.draw),
            believes_claim: nul(r.believes_claim),
            objection: nul(r.objection),
          });
        }
        return;
      case "replace_arm_stats": {
        const [run_id, round] = args as [string, number];
        this.tables.set("arm_stat", this.rows("arm_stat").filter((x) => !(x.run_id === run_id && x.round === round)));
        for (const r of list(2)) this.rows("arm_stat").push({ ...r, run_id, round });
        return;
      }
      case "upsert_learnings":
        for (const r of list(0)) {
          if (r.source !== "simulated") throw new SpacetimeError("source must be simulated", 400);
          this.upsert("learning", (x) => String(x.learning_id), { ...r, arm_id: nul(r.arm_id), evidence: json(r.evidence), valid_to_round: nul(r.valid_to_round) });
        }
        return;
      case "enqueue_task": {
        const [task_id, kind, payload] = args as [string, string, string];
        if (this.rows("task").some((x) => x.task_id === task_id)) throw new SpacetimeError(`task ${task_id} already exists`, 400);
        const p = JSON.parse(payload) as SqlRow;
        const t = this.now();
        this.rows("task").push({ task_id, run_id: p.run_id, kind, payload, status: "queued", claimed_by: null, result: null, created_at: t, updated_at: t });
        return;
      }
      case "claim_task": {
        const [task_id, claimed_by] = args as [string, string];
        const t = this.rows("task").find((x) => x.task_id === task_id);
        if (!t || t.status !== "queued") throw new SpacetimeError(`task ${task_id} is ${t?.status ?? "missing"}`, 400);
        Object.assign(t, { status: "claimed", claimed_by, updated_at: this.now() });
        return;
      }
      case "complete_task": {
        const [task_id, result] = args as [string, string];
        const t = this.rows("task").find((x) => x.task_id === task_id);
        if (!t || t.status !== "claimed") throw new SpacetimeError(`task ${task_id} is not claimed`, 400);
        Object.assign(t, { status: "done", result, updated_at: this.now() });
        return;
      }
      case "fail_task": {
        const [task_id, error] = args as [string, string];
        const t = this.rows("task").find((x) => x.task_id === task_id);
        if (!t) throw new SpacetimeError(`task ${task_id} not found`, 400);
        Object.assign(t, { status: "failed", result: JSON.stringify({ error }), updated_at: this.now() });
        return;
      }
      default:
        throw new SpacetimeError(`fake db: no reducer ${reducer}`, 404);
    }
  }
}

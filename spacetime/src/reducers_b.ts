import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';

// Person B's reducers. SpacetimeDB registers a reducer only when the module's entry file exports
// it, so index.ts re-exports this file (export * from './reducers_b'); reducers are built from the
// shared schema in schema.ts (DECISIONS D61).
//
// Batch writers take one JSON string of rows, so the sim worker makes one call per table per sim
// day over HTTP (POST /v1/database/<db>/call/<reducer> with a positional JSON array). Each
// reducer is one transaction: a bad row rejects the whole batch with a SenderError.
//
// The task board is shared: A's agents and creative worker use enqueue_task, claim_task,
// complete_task and fail_task exactly as B's sim worker does.

type Row = Record<string, unknown>;

const TASK_KINDS = ['run_round', 'generate_creatives'] as const;

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SenderError(`${what}: not valid JSON`);
  }
}

function rows(text: string, what: string): Row[] {
  const v = parseJson(text, what);
  if (!Array.isArray(v) || !v.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) {
    throw new SenderError(`${what}: expected a JSON array of objects`);
  }
  return v as Row[];
}

function object(text: string, what: string): Row {
  const v = parseJson(text, what);
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new SenderError(`${what}: expected a JSON object`);
  return v as Row;
}

function str(r: Row, k: string): string {
  const v = r[k];
  if (typeof v !== 'string' || v === '') throw new SenderError(`${k}: expected a non-empty string`);
  return v;
}

function num(r: Row, k: string): number {
  const v = r[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SenderError(`${k}: expected a finite number`);
  return v;
}

function uint(r: Row, k: string): number {
  const v = num(r, k);
  if (!Number.isInteger(v) || v < 0) throw new SenderError(`${k}: expected a non-negative integer`);
  return v;
}

function bool(r: Row, k: string): boolean {
  const v = r[k];
  if (typeof v !== 'boolean') throw new SenderError(`${k}: expected a boolean`);
  return v;
}

// The contract's "empty": null, absent or "" all mean none.
const isEmpty = (v: unknown) => v === null || v === undefined || v === '';
const optNum = (r: Row, k: string) => (isEmpty(r[k]) ? undefined : num(r, k));
const optUint = (r: Row, k: string) => (isEmpty(r[k]) ? undefined : uint(r, k));
const optStr = (r: Row, k: string) => (isEmpty(r[k]) ? undefined : str(r, k));

// A json column: a parsed value is stored as its JSON text; a string is checked and kept.
function json(r: Row, k: string): string {
  const v = r[k];
  if (v === undefined) throw new SenderError(`${k}: missing`);
  if (typeof v === 'string') {
    parseJson(v, k);
    return v;
  }
  return JSON.stringify(v);
}

function checkPayload(kind: string, payload: Row): void {
  str(payload, 'run_id');
  uint(payload, 'round');
  if (kind === 'generate_creatives') {
    const arms = payload.arms;
    if (!Array.isArray(arms)) throw new SenderError('arms: expected an array');
    for (const a of arms as Row[]) {
      str(a, 'arm_id');
      if (!Array.isArray(a.segment_ids)) throw new SenderError('segment_ids: expected an array');
    }
    uint(payload, 'n_per_arm');
    if (!Array.isArray(payload.learning_ids)) throw new SenderError('learning_ids: expected an array');
  }
}

export const upsertProducts = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  for (const r of rows(rows_json, 'products')) {
    const row = {
      product_id: str(r, 'product_id'),
      brand_id: str(r, 'brand_id'),
      name: str(r, 'name'),
      price_usd: num(r, 'price_usd'),
      subscription_price_usd: optNum(r, 'subscription_price_usd'),
      rating: num(r, 'rating'),
      review_count: uint(r, 'review_count'),
      page_highlights: json(r, 'page_highlights'),
      shipping_note: typeof r.shipping_note === 'string' ? r.shipping_note : '',
    };
    if (ctx.db.product.product_id.find(row.product_id)) ctx.db.product.product_id.update(row);
    else ctx.db.product.insert(row);
  }
});

// Frozen per creative: the same input_hash is never rewritten; a changed ad (new hash) is.
export const upsertCreativePerceptions = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  for (const r of rows(rows_json, 'creative_perceptions')) {
    const row = {
      creative_id: str(r, 'creative_id'),
      claims: json(r, 'claims'),
      offer_pct: num(r, 'offer_pct'),
      input_hash: str(r, 'input_hash'),
    };
    const old = ctx.db.creative_perception.creative_id.find(row.creative_id);
    if (!old) ctx.db.creative_perception.insert(row);
    else if (old.input_hash !== row.input_hash) ctx.db.creative_perception.creative_id.update(row);
  }
});

// Creates the run row, or updates its status and calibration; created_at is kept.
export const upsertRun = spacetimedb.reducer({ row_json: t.string() }, (ctx, { row_json }) => {
  const r = object(row_json, 'run');
  const old = ctx.db.run.run_id.find(str(r, 'run_id'));
  const row = {
    run_id: str(r, 'run_id'),
    seed: uint(r, 'seed'),
    population: uint(r, 'population'),
    rounds_planned: uint(r, 'rounds_planned'),
    ticks_per_round: uint(r, 'ticks_per_round'),
    status: str(r, 'status'),
    calibration: json(r, 'calibration'),
    jev_model: str(r, 'jev_model'),
    config_hash: str(r, 'config_hash'),
    created_at: old ? old.created_at : ctx.timestamp,
  };
  if (old) ctx.db.run.run_id.update(row);
  else ctx.db.run.insert(row);
});

export const startRound = spacetimedb.reducer({ run_id: t.string(), round: t.u32() }, (ctx, { run_id, round }) => {
  for (const old of ctx.db.round.run_id.filter(run_id)) if (old.round === round) ctx.db.round.delete(old);
  ctx.db.round.insert({ run_id, round, status: 'running', started_at: ctx.timestamp, finished_at: undefined, summary: '{}' });
});

// The round summary lands here; it is what A's round-summary endpoint and cards read.
export const finishRound = spacetimedb.reducer(
  { run_id: t.string(), round: t.u32(), status: t.string(), summary_json: t.string() },
  (ctx, { run_id, round, status, summary_json }) => {
    object(summary_json, 'summary');
    let started_at = undefined;
    for (const old of ctx.db.round.run_id.filter(run_id)) {
      if (old.round !== round) continue;
      started_at = old.started_at;
      ctx.db.round.delete(old);
    }
    ctx.db.round.insert({ run_id, round, status, started_at, finished_at: ctx.timestamp, summary: summary_json });
  }
);

// End of a sim day: every shopper's current state replaces its row for the run.
export const upsertShoppers = spacetimedb.reducer({ run_id: t.string(), rows_json: t.string() }, (ctx, { run_id, rows_json }) => {
  const batch = rows(rows_json, 'shoppers').map((r) => ({
    run_id,
    shopper_id: str(r, 'shopper_id'),
    segment_id: str(r, 'segment_id'),
    display_name: str(r, 'display_name'),
    in_market: bool(r, 'in_market'),
    budget_left_usd: num(r, 'budget_left_usd'),
    state_text: typeof r.state_text === 'string' ? r.state_text : '',
  }));
  const ids = new Set(batch.map((r) => r.shopper_id));
  for (const old of ctx.db.shopper.run_id.filter(run_id)) if (ids.has(old.shopper_id)) ctx.db.shopper.delete(old);
  for (const row of batch) ctx.db.shopper.insert(row);
});

// End of a sim day: the day's decision rows, one per Jev call. Append-only.
export const insertDecisions = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  for (const r of rows(rows_json, 'decisions')) {
    const kind = str(r, 'kind');
    if (kind !== 'feed' && kind !== 'page') throw new SenderError(`kind: expected feed or page, got ${kind}`);
    ctx.db.decision.insert({
      run_id: str(r, 'run_id'),
      round: uint(r, 'round'),
      tick: uint(r, 'tick'),
      shopper_id: str(r, 'shopper_id'),
      kind,
      creative_id: str(r, 'creative_id'),
      options: json(r, 'options'),
      p_raw: json(r, 'p_raw'),
      p_cal: json(r, 'p_cal'),
      draw: json(r, 'draw'),
      action: str(r, 'action'),
      believes_claim: optNum(r, 'believes_claim'),
      objection: optStr(r, 'objection'),
      latency_ms: uint(r, 'latency_ms'),
      cache_hit: bool(r, 'cache_hit'),
    });
  }
});

// End of a sim day: the round's arm stats are replaced by the day's refreshed set.
export const replaceArmStats = spacetimedb.reducer(
  { run_id: t.string(), round: t.u32(), rows_json: t.string() },
  (ctx, { run_id, round, rows_json }) => {
    const batch = rows(rows_json, 'arm_stats').map((r) => ({
      run_id,
      round,
      segment_id: str(r, 'segment_id'),
      arm_id: str(r, 'arm_id'),
      impressions: uint(r, 'impressions'),
      mean_reward: optNum(r, 'mean_reward'),
      post_mean: num(r, 'post_mean'),
      post_sd: num(r, 'post_sd'),
      p_best: num(r, 'p_best'),
      est_cost_per_order_usd: optNum(r, 'est_cost_per_order_usd'),
    }));
    for (const old of ctx.db.arm_stat.run_id.filter(run_id)) if (old.round === round) ctx.db.arm_stat.delete(old);
    for (const row of batch) ctx.db.arm_stat.insert(row);
  }
);

// End of a round: new versions, and old versions with their valid_to_round now set.
export const upsertLearnings = spacetimedb.reducer({ rows_json: t.string() }, (ctx, { rows_json }) => {
  for (const r of rows(rows_json, 'learnings')) {
    const row = {
      learning_id: str(r, 'learning_id'),
      run_id: str(r, 'run_id'),
      segment_id: str(r, 'segment_id'),
      arm_id: optStr(r, 'arm_id'),
      kind: str(r, 'kind'),
      statement: str(r, 'statement'),
      directive: str(r, 'directive'),
      evidence: json(r, 'evidence'),
      source: str(r, 'source'),
      valid_from_round: uint(r, 'valid_from_round'),
      valid_to_round: optUint(r, 'valid_to_round'),
    };
    if (row.source !== 'simulated') throw new SenderError('source: learnings are always "simulated"');
    if (ctx.db.learning.learning_id.find(row.learning_id)) ctx.db.learning.learning_id.update(row);
    else ctx.db.learning.insert(row);
  }
});

// The task board.
export const enqueueTask = spacetimedb.reducer(
  { task_id: t.string(), kind: t.string(), payload_json: t.string() },
  (ctx, { task_id, kind, payload_json }) => {
    if (!(TASK_KINDS as readonly string[]).includes(kind)) throw new SenderError(`kind: expected ${TASK_KINDS.join(' or ')}`);
    if (ctx.db.task.task_id.find(task_id)) throw new SenderError(`task ${task_id} already exists`);
    const payload = object(payload_json, 'payload');
    checkPayload(kind, payload);
    ctx.db.task.insert({
      task_id,
      run_id: payload.run_id as string,
      kind,
      payload: payload_json,
      status: 'queued',
      claimed_by: undefined,
      result: undefined,
      created_at: ctx.timestamp,
      updated_at: ctx.timestamp,
    });
  }
);

// The only way to take a task. One transaction checks and flips the status, so two workers
// can never both claim it: the second gets a SenderError.
export const claimTask = spacetimedb.reducer({ task_id: t.string(), claimed_by: t.string() }, (ctx, { task_id, claimed_by }) => {
  const task = ctx.db.task.task_id.find(task_id);
  if (!task) throw new SenderError(`task ${task_id} not found`);
  if (task.status !== 'queued') throw new SenderError(`task ${task_id} is ${task.status}`);
  ctx.db.task.task_id.update({ ...task, status: 'claimed', claimed_by, updated_at: ctx.timestamp });
});

export const completeTask = spacetimedb.reducer({ task_id: t.string(), result_json: t.string() }, (ctx, { task_id, result_json }) => {
  const task = ctx.db.task.task_id.find(task_id);
  if (!task) throw new SenderError(`task ${task_id} not found`);
  if (task.status !== 'claimed') throw new SenderError(`task ${task_id} is ${task.status}, not claimed`);
  object(result_json, 'result');
  ctx.db.task.task_id.update({ ...task, status: 'done', result: result_json, updated_at: ctx.timestamp });
});

export const failTask = spacetimedb.reducer({ task_id: t.string(), error: t.string() }, (ctx, { task_id, error }) => {
  const task = ctx.db.task.task_id.find(task_id);
  if (!task) throw new SenderError(`task ${task_id} not found`);
  ctx.db.task.task_id.update({
    ...task,
    status: 'failed',
    result: JSON.stringify({ error }),
    updated_at: ctx.timestamp,
  });
});

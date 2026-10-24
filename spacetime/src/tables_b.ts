import { t, table } from 'spacetimedb/server';

// Tables written by Person B (docs/PLAN.md "The contract"): product, creative_perception, run,
// round, shopper, decision, arm_stat, learning, and the shared task board. Their reducers are in
// reducers_b.ts. Add columns; never drop them mid-hackathon (republish with --delete-data instead).
//
// Column names are the contract's. Columns the contract marks json are strings holding JSON; an
// empty contract value is an option (absent). Tables without a single-column key (round, shopper,
// decision, arm_stat) are found through their run_id index and filtered in the reducer.
export const tablesB = {
  product: table(
    { name: 'product', public: true },
    {
      product_id: t.string().primaryKey(),
      brand_id: t.string(),
      name: t.string(),
      price_usd: t.f64(),
      // Absent: the brand has no subscription.
      subscription_price_usd: t.option(t.f64()),
      rating: t.f64(),
      review_count: t.u32(),
      page_highlights: t.string(), // json: string[]
      shipping_note: t.string(),
    }
  ),
  creative_perception: table(
    { name: 'creative_perception', public: true },
    {
      creative_id: t.string().primaryKey(),
      claims: t.string(), // json: concept key -> strength 0..1
      offer_pct: t.f64(),
      input_hash: t.string(),
    }
  ),
  run: table(
    { name: 'run', public: true },
    {
      run_id: t.string().primaryKey(),
      seed: t.u32(),
      population: t.u32(),
      rounds_planned: t.u32(),
      ticks_per_round: t.u32(),
      status: t.string(), // calibrating / running / done / failed
      calibration: t.string(), // json: offsets and the warm-up fit
      jev_model: t.string(),
      config_hash: t.string(),
      created_at: t.timestamp(),
    }
  ),
  round: table(
    { name: 'round', public: true },
    {
      run_id: t.string().index('btree'),
      round: t.u32(),
      status: t.string(), // running / done / failed
      started_at: t.option(t.timestamp()),
      finished_at: t.option(t.timestamp()),
      summary: t.string(), // json: what A's ASI:One cards render
    }
  ),
  shopper: table(
    { name: 'shopper', public: true },
    {
      run_id: t.string().index('btree'),
      shopper_id: t.string(),
      segment_id: t.string(),
      display_name: t.string(),
      in_market: t.bool(),
      budget_left_usd: t.f64(),
      state_text: t.string(),
    }
  ),
  decision: table(
    { name: 'decision', public: true },
    {
      run_id: t.string().index('btree'),
      round: t.u32(),
      tick: t.u32(),
      shopper_id: t.string(),
      kind: t.string(), // feed / page
      creative_id: t.string(),
      options: t.string(), // json
      p_raw: t.string(), // json
      p_cal: t.string(), // json
      draw: t.string(), // json: every uniform the call's dice used
      action: t.string(),
      believes_claim: t.option(t.f64()),
      objection: t.option(t.string()),
      latency_ms: t.u32(),
      cache_hit: t.bool(),
    }
  ),
  arm_stat: table(
    { name: 'arm_stat', public: true },
    {
      run_id: t.string().index('btree'),
      round: t.u32(),
      segment_id: t.string(),
      arm_id: t.string(),
      impressions: t.u32(),
      mean_reward: t.option(t.f64()),
      post_mean: t.f64(),
      post_sd: t.f64(),
      p_best: t.f64(),
      est_cost_per_order_usd: t.option(t.f64()),
    }
  ),
  learning: table(
    { name: 'learning', public: true },
    {
      learning_id: t.string().primaryKey(),
      run_id: t.string().index('btree'),
      segment_id: t.string(),
      arm_id: t.option(t.string()),
      kind: t.string(),
      statement: t.string(),
      directive: t.string(),
      evidence: t.string(), // json
      source: t.string(), // always "simulated"
      valid_from_round: t.u32(),
      valid_to_round: t.option(t.u32()),
    }
  ),
  // Shared: the task board. Both sides queue and claim through the reducers in reducers_b.ts.
  task: table(
    { name: 'task', public: true },
    {
      task_id: t.string().primaryKey(),
      run_id: t.string().index('btree'),
      kind: t.string(), // run_round / generate_creatives
      payload: t.string(), // json
      status: t.string().index('btree'), // queued / claimed / done / failed
      claimed_by: t.option(t.string()),
      result: t.option(t.string()), // json
      created_at: t.timestamp(),
      updated_at: t.timestamp(),
    }
  ),
};

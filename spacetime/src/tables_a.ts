import { table, t } from 'spacetimedb/server';

// Tables written by Person A (docs/PLAN.md "The contract"), read by Person B.
// Column names and order match the contract exactly; B's zod schemas (sim/src/contract.ts) are .strict().
//
// Wire conventions B relies on:
// - "Empty" is "" (never an option column): B's schemas accept "" or null, not undefined (D12).
// - json columns are JSON strings; B parses them (D13).
// - Integers are u32, not u64, so they arrive as numbers, not bigints.
//
// Add columns; never drop them mid-hackathon (republish with --delete-data instead).
// Writes go through the upsert reducers in reducers_a.ts, which validate every row.

export const brandRow = t.row('BrandRow', {
  brand_id: t.string().primaryKey(), // br_…
  name: t.string(),
  is_client: t.bool(),
});

export const conceptRow = t.row('ConceptRow', {
  concept_id: t.string().primaryKey(), // cpt_…
  key: t.string().unique(),
  label: t.string(),
});

export const segmentRow = t.row('SegmentRow', {
  segment_id: t.string().primaryKey(), // seg_…
  name: t.string(),
  description: t.string(), // life context only, never preferences
  share: t.f64(),
  prior_weights: t.string(), // json: concept key -> 0..1
  quotes: t.string(), // json: string[], 8-20 real quotes (at least 2)
  budget_mean_usd: t.f64(),
  budget_sd_usd: t.f64(),
  in_market_rate: t.f64(),
});

export const armRow = t.row('ArmRow', {
  arm_id: t.string().primaryKey(), // arm_…
  angle: t.string(), // "" for the control arm
  hook: t.string(), // "" for the control arm
  strategy: t.string(), // steal | double_down | gap | control
  rationale: t.string(),
  evidence: t.string(), // json: string[] of ad or fact ids
});

export const creativeRow = t.row('CreativeRow', {
  creative_id: t.string().primaryKey(), // cr_…
  arm_id: t.string().index('btree'), // "" for competitor ads
  brand_id: t.string().index('btree'),
  origin: t.string(), // generated | brand_live | competitor_live
  headline: t.string(),
  primary_text: t.string(),
  cta: t.string(),
  visual_description: t.string(),
  image_url: t.string(), // "" when none
  landing_product_id: t.string(), // prd_…, or ""
  days_running: t.u32(),
  round_created: t.u32(),
  learning_ids: t.string(), // json: string[]
  segment_id: t.string(), // persona it was written for; "" for live ads
  pack_fingerprint: t.string(), // "" for live ads
  status: t.string(), // ranked | gated_out
});

// Written by A's agents, read by anyone (the /agents view). Same conventions as above; the
// timestamps are set by the server (ctx.timestamp) in the reducers, never sent by the caller.
// The rules live in agent_rules.ts.

export const agentRow = t.row('AgentRow', {
  agent_id: t.string().primaryKey(), // agt_ad_lab | agt_scout | agt_strategist | agt_copywriter
  name: t.string(),
  role: t.string(),
  address: t.string(), // agent1q…, or "" until the agent first starts
  status: t.string(), // idle | working | error
  current_step: t.string(), // one line, <= 140 chars; "" when idle
  updated_at: t.timestamp(), // the last upsert_agent
});

export const agentMessageRow = t.row('AgentMessageRow', {
  message_id: t.string().primaryKey(), // msg_…, minted by the agent API
  run_id: t.string().index('btree'), // "" outside a run
  from_agent: t.string(), // agt_… or "user"
  to_agent: t.string(), // agt_… or "user"; never the same as from_agent
  protocol: t.string(),
  kind: t.string(), // request | reply | progress | result
  summary: t.string(), // one line, <= 140 chars
  payload: t.string(), // json object, <= 4096 bytes
  created_at: t.timestamp(),
});

export const ingestJobRow = t.row('IngestJobRow', {
  job_id: t.string().primaryKey(), // the Supabase job_queue id (uuid)
  requested_by: t.string(), // agt_… or "user"
  job_type: t.string(),
  target: t.string(), // readable, e.g. "Catalina Crunch · Meta ads"
  actor: t.string(), // the Apify actor; "" for steps without Apify
  status: t.string(), // pending | processing | completed | failed | skipped
  items: t.u32(), // rows the step added, when it reports them; else 0
  error: t.string(), // "" when none
  created_at: t.timestamp(),
  updated_at: t.timestamp(),
});

// The brand kit: the one row the onboarding step (/start) writes, read by the agents and /agents.
// The image itself is a file next to the web app (data/brand-kit/<image_file>); the row names it.
export const brandKitRow = t.row('BrandKitRow', {
  kit_id: t.string().primaryKey(), // always kit_default
  brand_url: t.string(), // the brand's website, http(s)
  brand_name: t.string(), // the onboarded brand the URL matched; "" when none
  image_file: t.string(), // <sha first 12>.<png|jpg|webp>
  image_sha: t.string(), // sha256 of the image bytes, hex
  updated_at: t.timestamp(),
});

export const tablesA = {
  brand: table({ name: 'brand', public: true }, brandRow),
  concept: table({ name: 'concept', public: true }, conceptRow),
  segment: table({ name: 'segment', public: true }, segmentRow),
  arm: table({ name: 'arm', public: true }, armRow),
  creative: table({ name: 'creative', public: true }, creativeRow),
  agent: table({ name: 'agent', public: true }, agentRow),
  agent_message: table({ name: 'agent_message', public: true }, agentMessageRow),
  ingest_job: table({ name: 'ingest_job', public: true }, ingestJobRow),
  brand_kit: table({ name: 'brand_kit', public: true }, brandKitRow),
};

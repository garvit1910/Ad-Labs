import { SenderError, t, type Infer, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import spacetimedb from './schema';
import { armRow, brandRow, conceptRow, creativeRow, segmentRow } from './tables_a';
import { agentProblem, ingestJobProblem, ingestReportProblem, isIngestTerminal, messageProblem } from './agent_rules';

// Batch writers for Person A's tables. Each call is one transaction: every row is validated, then
// upserted by primary key (updated if it exists, inserted if not). Any bad row throws a SenderError
// naming the row and the rule, and nothing from that call is written.
//
// The agent tables (agent, agent_message, ingest_job) are the exception, on purpose: their writers
// at the end of this file take scalar arguments for one row per call, and the server sets the
// timestamps from ctx.timestamp. A typed row would make every caller send SATS timestamps. Their
// rules are in agent_rules.ts, shared with the agent API; nothing from that file is re-exported.
//
// The checks mirror what B's reader rejects (sim/src/contract.ts and checkWorld in sim/src/fixtures.ts),
// so bad data fails here, at write time, instead of inside a sim run. Cross-table checks only look
// backwards in the load order brand -> concept -> segment -> arm -> creative. Rules that would be
// circular or need the whole data set are left to A4's final check and B's checkWorld: arm evidence
// citing existing ads, shares summing to 1, exactly one client and one control, 10-12 recipes, and
// landing products existing (B's product table).

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type Brand = Infer<typeof brandRow>;
type Concept = Infer<typeof conceptRow>;
type Segment = Infer<typeof segmentRow>;
type Arm = Infer<typeof armRow>;
type Creative = Infer<typeof creativeRow>;

// Adcero's food-industry angle tokens, plus price_value and trust_safety.
const ANGLES = [
  'taste_indulgence',
  'health_nutrition',
  'convenience',
  'natural_clean',
  'craving',
  'dietary_fit',
  'price_value',
  'trust_safety',
];
// HOOK_ARCHETYPES the copywriter can produce; never demo, comparison or other.
const HOOKS = [
  'problem_callout',
  'bold_claim',
  'question',
  'curiosity',
  'pov_relatable',
  'story_narrative',
  'statistic',
  'social_proof',
  'testimonial',
  'offer_led',
];
const STRATEGIES = ['steal', 'double_down', 'gap', 'control'];
const ORIGINS = ['generated', 'brand_live', 'competitor_live'];
const STATUSES = ['ranked', 'gated_out'];

function fail(where: string, message: string): never {
  throw new SenderError(`${where}: ${message}`);
}

function prefixed(where: string, field: string, value: string, prefix: string, allowEmpty = false): void {
  if (allowEmpty && value === '') return;
  if (!new RegExp(`^${prefix}[a-z0-9_]+$`).test(value)) {
    fail(where, `${field} "${value}" must look like ${prefix}<lowercase letters, digits, _>${allowEmpty ? ' or be ""' : ''}`);
  }
}

function nonEmpty(where: string, field: string, value: string): void {
  if (value.trim() === '') fail(where, `${field} is empty`);
}

function unit(where: string, field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) fail(where, `${field} ${value} is outside 0..1`);
}

function oneOf(where: string, field: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) fail(where, `${field} "${value}" is not one of ${allowed.join(', ')}`);
}

function parseJson(where: string, field: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fail(where, `${field} is not valid JSON`);
  }
}

function stringList(where: string, field: string, value: string, min = 0): string[] {
  const parsed = parseJson(where, field, value);
  if (!Array.isArray(parsed) || !parsed.every(s => typeof s === 'string' && s.trim() !== '')) {
    fail(where, `${field} must be a JSON array of non-empty strings`);
  }
  if (parsed.length < min) fail(where, `${field} needs at least ${min} entries, has ${parsed.length}`);
  return parsed;
}

function noDuplicateIds(table: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(`${table} ${id}`, 'appears twice in this batch');
    seen.add(id);
  }
}

function checkBrand(b: Brand): void {
  const where = `brand ${b.brand_id}`;
  prefixed(where, 'brand_id', b.brand_id, 'br_');
  nonEmpty(where, 'name', b.name);
}

function checkConcept(ctx: Ctx, c: Concept): void {
  const where = `concept ${c.concept_id}`;
  prefixed(where, 'concept_id', c.concept_id, 'cpt_');
  if (!/^[a-z][a-z0-9_]*$/.test(c.key)) fail(where, `key "${c.key}" must be lowercase snake_case`);
  nonEmpty(where, 'label', c.label);
  const holder = ctx.db.concept.key.find(c.key);
  if (holder && holder.concept_id !== c.concept_id) fail(where, `key "${c.key}" already belongs to ${holder.concept_id}`);
}

function checkSegment(ctx: Ctx, s: Segment): void {
  const where = `segment ${s.segment_id}`;
  prefixed(where, 'segment_id', s.segment_id, 'seg_');
  nonEmpty(where, 'name', s.name);
  nonEmpty(where, 'description', s.description);
  unit(where, 'share', s.share);
  const weights = parseJson(where, 'prior_weights', s.prior_weights);
  if (typeof weights !== 'object' || weights === null || Array.isArray(weights)) {
    fail(where, 'prior_weights must be a JSON object of concept key -> 0..1');
  }
  for (const [key, w] of Object.entries(weights)) {
    if (typeof w !== 'number') fail(where, `prior_weights.${key} is not a number`);
    unit(where, `prior_weights.${key}`, w);
    if (!ctx.db.concept.key.find(key)) fail(where, `prior_weights names unknown concept "${key}" (load concepts first)`);
  }
  stringList(where, 'quotes', s.quotes, 2);
  if (!Number.isFinite(s.budget_mean_usd) || s.budget_mean_usd <= 0) fail(where, 'budget_mean_usd must be > 0');
  if (!Number.isFinite(s.budget_sd_usd) || s.budget_sd_usd < 0) fail(where, 'budget_sd_usd must be >= 0');
  unit(where, 'in_market_rate', s.in_market_rate);
}

function checkArm(a: Arm): void {
  const where = `arm ${a.arm_id}`;
  prefixed(where, 'arm_id', a.arm_id, 'arm_');
  oneOf(where, 'strategy', a.strategy, STRATEGIES);
  if (a.strategy === 'control') {
    // The control is Magic Spoon's own live ads, not a recipe (D14).
    if (a.angle !== '' || a.hook !== '') fail(where, 'the control arm has no angle or hook; leave both ""');
  } else {
    oneOf(where, 'angle', a.angle, ANGLES);
    oneOf(where, 'hook', a.hook, HOOKS);
  }
  nonEmpty(where, 'rationale', a.rationale);
  stringList(where, 'evidence', a.evidence);
}

function checkCreative(ctx: Ctx, c: Creative): void {
  const where = `creative ${c.creative_id}`;
  prefixed(where, 'creative_id', c.creative_id, 'cr_');
  prefixed(where, 'arm_id', c.arm_id, 'arm_', true);
  prefixed(where, 'brand_id', c.brand_id, 'br_');
  oneOf(where, 'origin', c.origin, ORIGINS);
  nonEmpty(where, 'headline', c.headline);
  nonEmpty(where, 'primary_text', c.primary_text);
  nonEmpty(where, 'cta', c.cta);
  if (c.image_url !== '' && !/^https?:\/\/\S+$/.test(c.image_url)) fail(where, 'image_url must be an http(s) URL or ""');
  prefixed(where, 'landing_product_id', c.landing_product_id, 'prd_', true);
  stringList(where, 'learning_ids', c.learning_ids);
  prefixed(where, 'segment_id', c.segment_id, 'seg_', true);
  oneOf(where, 'status', c.status, STATUSES);

  const brand = ctx.db.brand.brand_id.find(c.brand_id);
  if (!brand) fail(where, `unknown brand ${c.brand_id} (load brands first)`);
  if (c.segment_id !== '' && !ctx.db.segment.segment_id.find(c.segment_id)) {
    fail(where, `unknown segment ${c.segment_id} (load segments first)`);
  }
  const arm = c.arm_id === '' ? null : ctx.db.arm.arm_id.find(c.arm_id);
  if (c.arm_id !== '' && !arm) fail(where, `unknown arm ${c.arm_id} (load arms first)`);

  switch (c.origin) {
    case 'competitor_live':
      if (brand.is_client) fail(where, 'competitor_live ad from the client brand');
      if (c.arm_id !== '') fail(where, 'competitor ads have no arm');
      if (c.segment_id !== '') fail(where, 'live ads have no segment');
      break;
    case 'brand_live':
      // The control arm is Magic Spoon's live ads, so they belong to it (D2).
      if (!brand.is_client) fail(where, 'brand_live ad from a competitor');
      if (arm?.strategy !== 'control') fail(where, 'brand_live ads belong to the control arm');
      if (c.segment_id !== '') fail(where, 'live ads have no segment');
      break;
    case 'generated':
      if (!brand.is_client) fail(where, 'generated ad from a competitor');
      if (c.arm_id === '') fail(where, 'generated ads need an arm');
      if (c.segment_id === '') fail(where, 'generated ads need the segment they were written for');
      break;
  }
}

export const upsertBrands = spacetimedb.reducer({ rows: t.array(brandRow) }, (ctx, { rows }) => {
  noDuplicateIds('brand', rows.map(r => r.brand_id));
  for (const row of rows) {
    checkBrand(row);
    if (ctx.db.brand.brand_id.find(row.brand_id)) ctx.db.brand.brand_id.update(row);
    else ctx.db.brand.insert(row);
  }
  const clients = [...ctx.db.brand.iter()].filter(b => b.is_client).map(b => b.brand_id);
  if (clients.length > 1) fail('brand', `only one client brand allowed, found ${clients.join(', ')}`);
});

export const upsertConcepts = spacetimedb.reducer({ rows: t.array(conceptRow) }, (ctx, { rows }) => {
  noDuplicateIds('concept', rows.map(r => r.concept_id));
  for (const row of rows) {
    checkConcept(ctx, row);
    if (ctx.db.concept.concept_id.find(row.concept_id)) ctx.db.concept.concept_id.update(row);
    else ctx.db.concept.insert(row);
  }
});

export const upsertSegments = spacetimedb.reducer({ rows: t.array(segmentRow) }, (ctx, { rows }) => {
  noDuplicateIds('segment', rows.map(r => r.segment_id));
  for (const row of rows) {
    checkSegment(ctx, row);
    if (ctx.db.segment.segment_id.find(row.segment_id)) ctx.db.segment.segment_id.update(row);
    else ctx.db.segment.insert(row);
  }
});

export const upsertArms = spacetimedb.reducer({ rows: t.array(armRow) }, (ctx, { rows }) => {
  noDuplicateIds('arm', rows.map(r => r.arm_id));
  for (const row of rows) {
    checkArm(row);
    if (ctx.db.arm.arm_id.find(row.arm_id)) ctx.db.arm.arm_id.update(row);
    else ctx.db.arm.insert(row);
  }
  const arms = [...ctx.db.arm.iter()];
  const controls = arms.filter(a => a.strategy === 'control').map(a => a.arm_id);
  if (controls.length > 1) fail('arm', `only one control arm allowed, found ${controls.join(', ')}`);
  const pairs = new Map<string, string>();
  for (const a of arms) {
    if (a.strategy === 'control') continue;
    const pair = `${a.angle} x ${a.hook}`;
    const other = pairs.get(pair);
    if (other) fail(`arm ${a.arm_id}`, `same recipe (${pair}) as ${other}; recipes sharing an angle must use different hooks`);
    pairs.set(pair, a.arm_id);
  }
});

export const upsertCreatives = spacetimedb.reducer({ rows: t.array(creativeRow) }, (ctx, { rows }) => {
  noDuplicateIds('creative', rows.map(r => r.creative_id));
  for (const row of rows) {
    checkCreative(ctx, row);
    if (ctx.db.creative.creative_id.find(row.creative_id)) ctx.db.creative.creative_id.update(row);
    else ctx.db.creative.insert(row);
  }
});

// Empties all five of A's data tables, for a clean A4 reload without --delete-data (which would also
// wipe B's runs). Only between runs: B's decision rows reference these ids. The agent tables are kept.
export const resetATables = spacetimedb.reducer(ctx => {
  ctx.db.creative.clear();
  ctx.db.arm.clear();
  ctx.db.segment.clear();
  ctx.db.concept.clear();
  ctx.db.brand.clear();
});

// The agent tables. Over HTTP: upsert_agent, log_agent_message, upsert_ingest_job and
// report_ingest_job, with positional arguments in the order declared below.

// One row per agent, updated whenever its step changes.
export const upsertAgent = spacetimedb.reducer(
  {
    agent_id: t.string(),
    name: t.string(),
    role: t.string(),
    address: t.string(),
    status: t.string(),
    current_step: t.string(),
  },
  (ctx, a) => {
    const problem = agentProblem(a);
    if (problem) fail(`agent ${a.agent_id}`, problem);
    const row = {
      agent_id: a.agent_id,
      name: a.name,
      role: a.role,
      address: a.address,
      status: a.status,
      current_step: a.current_step,
      updated_at: ctx.timestamp,
    };
    if (ctx.db.agent.agent_id.find(a.agent_id)) ctx.db.agent.agent_id.update(row);
    else ctx.db.agent.insert(row);
  }
);

// One row per message between agents (or with the ASI:One user), written by the sender. The agent
// API mints the id; a repeat id is rejected, so a message is never logged twice.
export const logAgentMessage = spacetimedb.reducer(
  {
    message_id: t.string(),
    run_id: t.string(),
    from_agent: t.string(),
    to_agent: t.string(),
    protocol: t.string(),
    kind: t.string(),
    summary: t.string(),
    payload: t.string(),
  },
  (ctx, m) => {
    const where = `message ${m.message_id}`;
    const problem = messageProblem(m);
    if (problem) fail(where, problem);
    if (ctx.db.agent_message.message_id.find(m.message_id)) fail(where, 'already logged');
    ctx.db.agent_message.insert({
      message_id: m.message_id,
      run_id: m.run_id,
      from_agent: m.from_agent,
      to_agent: m.to_agent,
      protocol: m.protocol,
      kind: m.kind,
      summary: m.summary,
      payload: m.payload,
      created_at: ctx.timestamp,
    });
  }
);

// One row per Supabase job_queue job an agent starts, written by the endpoint that enqueues it.
export const upsertIngestJob = spacetimedb.reducer(
  {
    job_id: t.string(),
    requested_by: t.string(),
    job_type: t.string(),
    target: t.string(),
    actor: t.string(),
    status: t.string(),
    items: t.u32(),
    error: t.string(),
  },
  (ctx, j) => {
    const problem = ingestJobProblem(j);
    if (problem) fail(`ingest_job ${j.job_id}`, problem);
    const old = ctx.db.ingest_job.job_id.find(j.job_id);
    const row = {
      job_id: j.job_id,
      requested_by: j.requested_by,
      job_type: j.job_type,
      target: j.target,
      actor: j.actor,
      status: j.status,
      items: j.items,
      error: j.error,
      created_at: old ? old.created_at : ctx.timestamp,
      updated_at: ctx.timestamp,
    };
    if (old) ctx.db.ingest_job.job_id.update(row);
    else ctx.db.ingest_job.insert(row);
  }
);

// The worker's progress reports. Only rows an endpoint created are updated: an unknown job id (a
// child job, A2's bulk jobs) is a silent no-op. A finished job (completed, failed, skipped) never
// goes back to pending or processing. items keeps its old value unless the report's is > 0.
export const reportIngestJob = spacetimedb.reducer(
  { job_id: t.string(), status: t.string(), items: t.u32(), error: t.string() },
  (ctx, r) => {
    const problem = ingestReportProblem(r);
    if (problem) fail(`ingest_job ${r.job_id}`, problem);
    const old = ctx.db.ingest_job.job_id.find(r.job_id);
    if (!old) return;
    if (isIngestTerminal(old.status) && !isIngestTerminal(r.status)) return;
    ctx.db.ingest_job.job_id.update({
      ...old,
      status: r.status,
      items: r.items > 0 ? r.items : old.items,
      error: r.error,
      updated_at: ctx.timestamp,
    });
  }
);

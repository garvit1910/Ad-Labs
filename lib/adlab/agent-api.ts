import { randomBytes } from 'node:crypto';
import {
  LIMITS,
  agentProblem,
  codePoints,
  ingestJobProblem,
  ingestReportProblem,
  messageProblem,
  utf8Bytes,
  type AgentInput,
  type IngestJobInput,
  type IngestReportInput,
} from '@/spacetime/src/agent_rules';
import { sqlString, type Spacetime, type SqlRow } from './spacetime-http';

/*
 * The agents' writers and readers (docs/AGENT_API.md), over A's plain-HTTP SpacetimeDB client.
 * Writers clamp what can be clamped (summary, payload, current step), then apply the module's own
 * rules (spacetime/src/agent_rules.ts) before calling the reducer, so a bad request is a 400 here
 * instead of a reducer error. Readers return snake_case rows as SQL decodes them (options as null,
 * timestamps as ISO strings), with JSON columns parsed.
 */

/** A request the agent rules reject; the routes answer 400 bad_request. */
export class AgentRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRuleError';
  }
}

/** `msg_<base36 ms>_<8 hex>`: sortable by time, unique per call. */
export function newMessageId(now: number = Date.now()): string {
  return `msg_${now.toString(36)}_${randomBytes(4).toString('hex')}`;
}

/** One line (whitespace runs, newlines included, become one space) of at most `max` code points, ending in '…' when cut. */
export function clampLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (codePoints(line) <= max) return line;
  return `${[...line].slice(0, max - 1).join('').trimEnd()}…`;
}

/** The payload as JSON; over 4096 bytes it becomes {truncated: true, bytes, keys} (as many keys as fit). */
export function boundedPayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const bytes = utf8Bytes(json);
  if (bytes <= LIMITS.payloadBytes) return json;
  let keys = Object.keys(payload)
    .slice(0, 50)
    .map((key) => clampLine(key, 64));
  for (;;) {
    const stub = JSON.stringify({ truncated: true, bytes, keys });
    if (utf8Bytes(stub) <= LIMITS.payloadBytes) return stub;
    keys = keys.slice(0, Math.floor(keys.length / 2));
  }
}

export interface MessageRequest {
  from_agent: string;
  to_agent: string;
  protocol: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  run_id?: string;
}

/** Logs one message (log_agent_message) and returns its minted id. */
export async function logAgentMessage(spacetime: Spacetime, m: MessageRequest, now: number = Date.now()): Promise<string> {
  const row = {
    message_id: newMessageId(now),
    run_id: m.run_id ?? '',
    from_agent: m.from_agent,
    to_agent: m.to_agent,
    protocol: m.protocol.trim(),
    kind: m.kind,
    summary: clampLine(m.summary, LIMITS.summary),
    payload: boundedPayload(m.payload),
  };
  const problem = messageProblem(row);
  if (problem) throw new AgentRuleError(problem);
  await spacetime.call('log_agent_message', [
    row.message_id,
    row.run_id,
    row.from_agent,
    row.to_agent,
    row.protocol,
    row.kind,
    row.summary,
    row.payload,
  ]);
  return row.message_id;
}

/** Upserts the agent's row (upsert_agent); current_step is clamped to one line of 140. */
export async function setAgentStatus(spacetime: Spacetime, s: AgentInput): Promise<void> {
  const row: AgentInput = { ...s, current_step: clampLine(s.current_step, LIMITS.step) };
  const problem = agentProblem(row);
  if (problem) throw new AgentRuleError(problem);
  await spacetime.call('upsert_agent', [row.agent_id, row.name, row.role, row.address, row.status, row.current_step]);
}

/** One readable ingest_job row per job_queue job (upsert_ingest_job). */
export async function upsertIngestJob(spacetime: Spacetime, j: IngestJobInput): Promise<void> {
  const problem = ingestJobProblem(j);
  if (problem) throw new AgentRuleError(problem);
  await spacetime.call('upsert_ingest_job', [j.job_id, j.requested_by, j.job_type, j.target, j.actor, j.status, j.items, j.error]);
}

/** The worker's progress on a job (report_ingest_job); a no-op for unknown ids and finished jobs. */
export async function reportIngestJob(spacetime: Spacetime, r: IngestReportInput): Promise<void> {
  const problem = ingestReportProblem(r);
  if (problem) throw new AgentRuleError(problem);
  await spacetime.call('report_ingest_job', [r.job_id, r.status, r.items, r.error]);
}

// ── Readers ─────────────────────────────────────────────────────────────────

export interface RunRow {
  run_id: string;
  seed: number;
  population: number;
  rounds_planned: number;
  ticks_per_round: number;
  status: string;
  calibration: string;
  jev_model: string;
  config_hash: string;
  created_at: string;
}

export interface RoundRow {
  run_id: string;
  round: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  summary: string;
}

export interface TaskRow {
  task_id: string;
  run_id: string;
  kind: string;
  payload: string;
  status: string;
  claimed_by: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

/** docs/AGENT_API.md "The Task shape". */
export interface Task {
  task_id: string;
  run_id: string;
  kind: string;
  status: string;
  claimed_by: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface LearningRow {
  learning_id: string;
  run_id: string;
  segment_id: string;
  arm_id: string | null;
  kind: string;
  statement: string;
  directive: string;
  evidence: string;
  source: string;
  valid_from_round: number;
  valid_to_round: number | null;
}

export interface Learning {
  learning_id: string;
  segment_id: string;
  segment_name: string;
  arm_id: string | null;
  kind: string;
  statement: string;
  directive: string;
  /** What the learning is about: the objection key (e.g. not_now), the doubted concept, else "". */
  topic: string;
  valid_from_round: number;
  valid_to_round: number | null;
}

/** evidence.objection for an objection, evidence.concept for a claim doubt (sim/src/learnings.ts). */
export function learningTopic(kind: string, evidence: unknown): string {
  let value: unknown = evidence;
  if (typeof evidence === 'string') {
    try {
      value = JSON.parse(evidence);
    } catch {
      return '';
    }
  }
  if (!value || typeof value !== 'object') return '';
  const e = value as Record<string, unknown>;
  const topic = kind === 'objection' ? e.objection : kind === 'claim_doubt' ? e.concept : undefined;
  return typeof topic === 'string' ? topic : '';
}

export interface ArmRow {
  arm_id: string;
  angle: string;
  hook: string;
  strategy: string;
  rationale: string;
  evidence: string;
}

export interface SegmentRow {
  segment_id: string;
  name: string;
  share: number;
}

export interface CreativeRow {
  creative_id: string;
  arm_id: string;
  brand_id: string;
  origin: string;
  headline: string;
  primary_text: string;
  cta: string;
  visual_description: string;
  image_url: string;
  round_created: number;
  learning_ids: string;
  segment_id: string;
  status: string;
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null || text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseTask(row: TaskRow): Task {
  return {
    task_id: row.task_id,
    run_id: row.run_id,
    kind: row.kind,
    status: row.status,
    claimed_by: row.claimed_by ?? null,
    payload: parseObject(row.payload) ?? {},
    result: parseObject(row.result),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const where = (filters: Record<string, string | undefined>): string => {
  const parts = Object.entries(filters)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([column, value]) => `${column} = ${sqlString(value)}`);
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
};

const byCreated = (a: { created_at: string; task_id: string }, b: { created_at: string; task_id: string }) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;

export interface TaskFilter {
  task_id?: string;
  run_id?: string;
  status?: string;
  kind?: string;
}

/** Tasks matching every given filter, oldest first. */
export async function readTasks(spacetime: Spacetime, filter: TaskFilter = {}): Promise<Task[]> {
  const rows = await spacetime.sql<TaskRow>(
    `SELECT * FROM task${where({ task_id: filter.task_id, run_id: filter.run_id, status: filter.status, kind: filter.kind })}`,
  );
  return rows.sort(byCreated).map(parseTask);
}

export async function readRun(spacetime: Spacetime, runId: string): Promise<RunRow | null> {
  return (await spacetime.sql<RunRow>(`SELECT * FROM run${where({ run_id: runId })}`))[0] ?? null;
}

/** The run's round rows, by round. */
export async function readRounds(spacetime: Spacetime, runId: string): Promise<RoundRow[]> {
  return (await spacetime.sql<RoundRow>(`SELECT * FROM round${where({ run_id: runId })}`)).sort((a, b) => a.round - b.round);
}

export async function readArms(spacetime: Spacetime): Promise<ArmRow[]> {
  return (await spacetime.sql<ArmRow>('SELECT * FROM arm')).sort((a, b) => (a.arm_id < b.arm_id ? -1 : 1));
}

/** Segments, largest share first. */
export async function readSegments(spacetime: Spacetime): Promise<SegmentRow[]> {
  const rows = await spacetime.sql<SegmentRow & SqlRow>('SELECT * FROM segment');
  return rows
    .map(({ segment_id, name, share }) => ({ segment_id, name, share: Number(share) }))
    .sort((a, b) => b.share - a.share || (a.segment_id < b.segment_id ? -1 : 1));
}

export async function readLearningRows(spacetime: Spacetime, runId?: string): Promise<LearningRow[]> {
  return spacetime.sql<LearningRow>(`SELECT * FROM learning${where({ run_id: runId })}`);
}

export async function readGeneratedCreatives(spacetime: Spacetime): Promise<CreativeRow[]> {
  return spacetime.sql<CreativeRow>("SELECT * FROM creative WHERE origin = 'generated'");
}

/** Learnings with their segment's name, optionally only `ids`, by round then id. */
export async function readLearnings(spacetime: Spacetime, filter: { run_id?: string; ids?: string[] } = {}): Promise<Learning[]> {
  const [rows, segments] = await Promise.all([readLearningRows(spacetime, filter.run_id), readSegments(spacetime)]);
  const names = new Map(segments.map((segment) => [segment.segment_id, segment.name]));
  const wanted = filter.ids?.length ? new Set(filter.ids) : null;
  return rows
    .filter((row) => !wanted || wanted.has(row.learning_id))
    .sort((a, b) => a.valid_from_round - b.valid_from_round || (a.learning_id < b.learning_id ? -1 : 1))
    .map((row) => ({
      learning_id: row.learning_id,
      segment_id: row.segment_id,
      segment_name: names.get(row.segment_id) ?? row.segment_id,
      arm_id: row.arm_id ?? null,
      kind: row.kind,
      statement: row.statement,
      directive: row.directive,
      topic: learningTopic(row.kind, row.evidence),
      valid_from_round: row.valid_from_round,
      valid_to_round: row.valid_to_round ?? null,
    }));
}

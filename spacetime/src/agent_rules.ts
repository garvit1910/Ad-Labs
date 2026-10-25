// Pure validation rules for A's agent tables: agent, agent_message and ingest_job
// (docs/PLAN.md "The contract", "Written by A's agents").
//
// No imports, so the module's reducers (reducers_a.ts), the Next API and the unit tests all share
// these rules and can never disagree. Never re-export this file from index.ts: B's module test
// asserts the module's exact export list.
//
// Each *Problem function returns the first problem as one sentence, or null when the value is fine.

export const AGENT_IDS = ['agt_ad_lab', 'agt_scout', 'agt_strategist', 'agt_copywriter'] as const;
// The ASI:One user, so the chat shows up in agent_message too.
export const USER = 'user';
export const PARTIES = [...AGENT_IDS, USER] as const;
export const AGENT_STATUSES = ['idle', 'working', 'error'] as const;
export const MESSAGE_KINDS = ['request', 'reply', 'progress', 'result'] as const;
export const INGEST_STATUSES = ['pending', 'processing', 'completed', 'failed', 'skipped'] as const;
// A job in one of these states is finished; report_ingest_job never moves it back.
export const INGEST_TERMINAL = ['completed', 'failed', 'skipped'] as const;

export type AgentId = (typeof AGENT_IDS)[number];
export type Party = (typeof PARTIES)[number];
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type IngestStatus = (typeof INGEST_STATUSES)[number];

// Lengths are in characters (code points), except payloadBytes, which is UTF-8 bytes.
export const LIMITS = {
  summary: 140,
  step: 140,
  payloadBytes: 4096,
  name: 40,
  role: 80,
  protocol: 80,
  target: 120,
  actor: 80,
  error: 1000,
} as const;

export const MESSAGE_ID_RE = /^msg_[a-z0-9_]+$/;
export const RUN_ID_RE = /^[a-z0-9_]+$/;
export const ADDRESS_RE = /^agent1[0-9a-z]+$/;
// The Supabase job_queue id (or a random uuid for dry rows), lowercase.
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const JOB_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface AgentInput {
  agent_id: string;
  name: string;
  role: string;
  address: string;
  status: string;
  current_step: string;
}

export interface MessageInput {
  message_id: string;
  run_id: string;
  from_agent: string;
  to_agent: string;
  protocol: string;
  kind: string;
  summary: string;
  payload: string;
}

export interface IngestJobInput {
  job_id: string;
  requested_by: string;
  job_type: string;
  target: string;
  actor: string;
  status: string;
  items: number;
  error: string;
}

export interface IngestReportInput {
  job_id: string;
  status: string;
  items: number;
  error: string;
}

const includes = (allowed: readonly string[], value: string): boolean => allowed.includes(value);

export const isAgentId = (v: string): boolean => includes(AGENT_IDS as readonly string[], v);
export const isParty = (v: string): boolean => includes(PARTIES as readonly string[], v);
export const isAgentStatus = (v: string): boolean => includes(AGENT_STATUSES as readonly string[], v);
export const isMessageKind = (v: string): boolean => includes(MESSAGE_KINDS as readonly string[], v);
export const isIngestStatus = (v: string): boolean => includes(INGEST_STATUSES as readonly string[], v);
export const isIngestTerminal = (v: string): boolean => includes(INGEST_TERMINAL as readonly string[], v);

// UTF-8 length without TextEncoder (not available in the module runtime). A lone surrogate counts
// as 3 bytes, as TextEncoder and Buffer encode it (U+FFFD).
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export const isOneLine = (s: string): boolean => !/[\r\n]/.test(s);

function oneOf(field: string, value: string, allowed: readonly string[]): string | null {
  return includes(allowed, value) ? null : `${field} "${value}" is not one of ${allowed.join(', ')}`;
}

function bounded(field: string, value: string, max: number, required: boolean): string | null {
  if (required && value.trim() === '') return `${field} is empty`;
  const n = codePoints(value);
  return n > max ? `${field} is ${n} characters, more than ${max}` : null;
}

function oneLine(field: string, value: string): string | null {
  return isOneLine(value) ? null : `${field} must be one line`;
}

export function messageIdProblem(id: string): string | null {
  return MESSAGE_ID_RE.test(id) ? null : `message_id "${id}" must look like msg_<lowercase letters, digits, _>`;
}

export function runIdProblem(runId: string): string | null {
  return runId === '' || RUN_ID_RE.test(runId) ? null : `run_id "${runId}" must be "" or lowercase letters, digits, _`;
}

export function addressProblem(address: string): string | null {
  return address === '' || ADDRESS_RE.test(address) ? null : `address "${address}" must be "" or an agent1… address`;
}

export function currentStepProblem(step: string): string | null {
  return bounded('current_step', step, LIMITS.step, false) ?? oneLine('current_step', step);
}

export function summaryProblem(summary: string): string | null {
  return bounded('summary', summary, LIMITS.summary, true) ?? oneLine('summary', summary);
}

export function payloadProblem(payload: string): string | null {
  const bytes = utf8Bytes(payload);
  if (bytes > LIMITS.payloadBytes) return `payload is ${bytes} bytes, more than ${LIMITS.payloadBytes}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return 'payload is not valid JSON';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'payload must be a JSON object';
  return null;
}

function itemsProblem(items: number): string | null {
  return Number.isInteger(items) && items >= 0 && items <= 0xffffffff ? null : `items ${items} must be a whole number >= 0`;
}

function jobIdProblem(jobId: string): string | null {
  return JOB_ID_RE.test(jobId) ? null : `job_id "${jobId}" must be a lowercase uuid`;
}

export function agentProblem(a: AgentInput): string | null {
  return (
    oneOf('agent_id', a.agent_id, AGENT_IDS) ??
    bounded('name', a.name, LIMITS.name, true) ??
    bounded('role', a.role, LIMITS.role, true) ??
    addressProblem(a.address) ??
    oneOf('status', a.status, AGENT_STATUSES) ??
    currentStepProblem(a.current_step)
  );
}

export function messageProblem(m: MessageInput): string | null {
  return (
    messageIdProblem(m.message_id) ??
    runIdProblem(m.run_id) ??
    oneOf('from_agent', m.from_agent, PARTIES) ??
    oneOf('to_agent', m.to_agent, PARTIES) ??
    (m.from_agent === m.to_agent ? `from_agent and to_agent are both "${m.from_agent}"` : null) ??
    bounded('protocol', m.protocol, LIMITS.protocol, true) ??
    oneOf('kind', m.kind, MESSAGE_KINDS) ??
    summaryProblem(m.summary) ??
    payloadProblem(m.payload)
  );
}

export function ingestJobProblem(j: IngestJobInput): string | null {
  return (
    jobIdProblem(j.job_id) ??
    oneOf('requested_by', j.requested_by, PARTIES) ??
    (JOB_TYPE_RE.test(j.job_type) ? null : `job_type "${j.job_type}" must be lowercase snake_case`) ??
    bounded('target', j.target, LIMITS.target, true) ??
    bounded('actor', j.actor, LIMITS.actor, false) ??
    oneOf('status', j.status, INGEST_STATUSES) ??
    itemsProblem(j.items) ??
    bounded('error', j.error, LIMITS.error, false)
  );
}

export function ingestReportProblem(r: IngestReportInput): string | null {
  return (
    jobIdProblem(r.job_id) ??
    oneOf('status', r.status, INGEST_STATUSES) ??
    itemsProblem(r.items) ??
    bounded('error', r.error, LIMITS.error, false)
  );
}

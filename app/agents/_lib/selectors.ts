import type { StatusPillTone } from '@/components/ui/status-pill';

// Pure view selectors for /agents. They take the camelCase rows the generated bindings give
// (lib/spacetime/bindings), typed structurally so the tests can pass plain objects.

export const AGENT_ORDER = ['agt_ad_lab', 'agt_scout', 'agt_strategist', 'agt_copywriter'] as const;
export type AgentId = (typeof AGENT_ORDER)[number];

/** Shown until an agent's first upsert_agent; the agents send their own name and role after that. */
export const AGENT_DEFAULTS: Record<AgentId, { name: string; role: string }> = {
  agt_ad_lab: { name: 'Ad Lab', role: 'Talks to you on ASI:One and coordinates the team' },
  agt_scout: { name: 'Scout', role: 'Refreshes competitor ads and brand listening' },
  agt_strategist: { name: 'Strategist', role: 'Builds the recipes and runs the simulated rounds' },
  agt_copywriter: { name: 'Copywriter', role: 'Writes new ads from what each round learned' },
};

export const USER_NAME = 'You (ASI:One)';

type Ts = { microsSinceUnixEpoch: bigint };

export interface AgentRowLike {
  agentId: string;
  name: string;
  role: string;
  address: string;
  status: string;
  currentStep: string;
  updatedAt: Ts;
}

export interface MessageRowLike {
  messageId: string;
  runId: string;
  fromAgent: string;
  toAgent: string;
  protocol: string;
  kind: string;
  summary: string;
  payload: string;
  createdAt: Ts;
}

export interface IngestJobRowLike {
  jobId: string;
  requestedBy: string;
  jobType: string;
  target: string;
  actor: string;
  status: string;
  items: number;
  error: string;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface TaskRowLike {
  taskId: string;
  runId: string;
  kind: string;
  payload: string;
  status: string;
  claimedBy: string | undefined | null;
  result: string | undefined | null;
  createdAt: Ts;
  updatedAt: Ts;
}

export interface RunRowLike {
  runId: string;
  createdAt: Ts;
}

export const tsMs = (ts: Ts): number => Number(ts.microsSinceUnixEpoch / BigInt(1000));

/** "just now", "12s ago", "4m ago", "2h ago", "3d ago". */
export function ago(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** HH:MM:SS in the viewer's time zone. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function partyName(id: string, agents: readonly AgentRowLike[] = []): string {
  if (id === 'user') return USER_NAME;
  const row = agents.find((a) => a.agentId === id);
  if (row?.name) return row.name;
  return AGENT_DEFAULTS[id as AgentId]?.name ?? id;
}

/** "agent1qf3x…9k2d"; "" stays "". */
export function shortAddress(address: string): string {
  return address.length > 18 ? `${address.slice(0, 11)}…${address.slice(-4)}` : address;
}

export function agentTone(status: string): StatusPillTone {
  switch (status) {
    case 'idle':
      return 'connected';
    case 'working':
      return 'active';
    case 'error':
      return 'failed';
    default:
      return 'not_set';
  }
}

export function ingestTone(status: string): StatusPillTone {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'processing':
      return 'active';
    case 'completed':
      return 'connected';
    case 'failed':
      return 'failed';
    default:
      return 'not_set';
  }
}

export const TASK_STATUSES = ['queued', 'claimed', 'done', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Same mapping as B's /sim/dev task board. */
export const TASK_TONE: Record<TaskStatus, StatusPillTone> = { queued: 'queued', claimed: 'active', done: 'connected', failed: 'failed' };

export interface AgentCardView {
  agentId: string;
  name: string;
  role: string;
  address: string;
  status: string;
  statusLabel: string;
  tone: StatusPillTone;
  currentStep: string;
  updatedMs: number | null;
  updatedAgo: string;
  /** No upsert_agent yet: the agent hasn't started. */
  placeholder: boolean;
  sent: number;
  received: number;
}

/** The four agents in a fixed order, placeholders until their rows exist, then any unknown ids. */
export function agentCards(agents: readonly AgentRowLike[], messages: readonly MessageRowLike[], now: number): AgentCardView[] {
  const byId = new Map(agents.map((a) => [a.agentId, a]));
  const extra = agents.map((a) => a.agentId).filter((id) => !(AGENT_ORDER as readonly string[]).includes(id)).sort();
  return [...AGENT_ORDER, ...extra].map((id) => {
    const row = byId.get(id);
    const defaults = AGENT_DEFAULTS[id as AgentId] ?? { name: id, role: '' };
    const updatedMs = row ? tsMs(row.updatedAt) : null;
    return {
      agentId: id,
      name: row?.name || defaults.name,
      role: row?.role || defaults.role,
      address: row?.address ?? '',
      status: row?.status ?? 'not_started',
      statusLabel: row ? row.status : 'not started',
      tone: row ? agentTone(row.status) : 'not_set',
      currentStep: row?.currentStep ?? '',
      updatedMs,
      updatedAgo: ago(updatedMs, now),
      placeholder: !row,
      sent: messages.filter((m) => m.fromAgent === id).length,
      received: messages.filter((m) => m.toAgent === id).length,
    };
  });
}

export interface MessageView {
  messageId: string;
  runId: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  protocol: string;
  kind: string;
  summary: string;
  payload: string;
  createdMs: number;
}

/** Pretty-printed JSON, or the text as it is when it doesn't parse. */
export function prettyPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

/** Newest first; `runId` and `agentId` filter (an agent matches as sender or receiver). */
export function messageStream(
  messages: readonly MessageRowLike[],
  opts: { runId?: string | null; agentId?: string | null; limit?: number; agents?: readonly AgentRowLike[] } = {},
): MessageView[] {
  const { runId, agentId, limit = 200, agents = [] } = opts;
  return messages
    .filter((m) => (runId == null || m.runId === runId) && (!agentId || m.fromAgent === agentId || m.toAgent === agentId))
    .map((m) => ({
      messageId: m.messageId,
      runId: m.runId,
      from: m.fromAgent,
      to: m.toAgent,
      fromName: partyName(m.fromAgent, agents),
      toName: partyName(m.toAgent, agents),
      protocol: m.protocol,
      kind: m.kind,
      summary: m.summary,
      payload: m.payload,
      createdMs: tsMs(m.createdAt),
    }))
    .sort((a, b) => b.createdMs - a.createdMs || b.messageId.localeCompare(a.messageId))
    .slice(0, limit);
}

export interface IngestJobView {
  jobId: string;
  requestedBy: string;
  requestedByName: string;
  jobType: string;
  target: string;
  actor: string;
  status: string;
  tone: StatusPillTone;
  items: number;
  error: string;
  dry: boolean;
  createdMs: number;
  updatedMs: number;
}

/** Newest first (by last update). */
export function jobRows(jobs: readonly IngestJobRowLike[], agents: readonly AgentRowLike[] = []): IngestJobView[] {
  return jobs
    .map((j) => ({
      jobId: j.jobId,
      requestedBy: j.requestedBy,
      requestedByName: partyName(j.requestedBy, agents),
      jobType: j.jobType,
      target: j.target,
      actor: j.actor,
      status: j.status,
      tone: ingestTone(j.status),
      items: j.items,
      error: j.error,
      dry: j.status === 'skipped' && j.error.startsWith('dry run'),
      createdMs: tsMs(j.createdAt),
      updatedMs: tsMs(j.updatedAt),
    }))
    .sort((a, b) => b.updatedMs - a.updatedMs || b.createdMs - a.createdMs || a.jobId.localeCompare(b.jobId));
}

/** The task board: tasks of `runId` (all tasks when null) by status, each column newest update first. */
export function taskColumns<T extends TaskRowLike>(tasks: readonly T[], runId?: string | null): Record<TaskStatus, T[]> {
  const columns: Record<TaskStatus, T[]> = { queued: [], claimed: [], done: [], failed: [] };
  for (const t of tasks) {
    if (runId != null && t.runId !== runId) continue;
    const column = columns[t.status as TaskStatus];
    if (column) column.push(t);
  }
  for (const s of TASK_STATUSES) columns[s].sort((a, b) => tsMs(b.updatedAt) - tsMs(a.updatedAt) || a.taskId.localeCompare(b.taskId));
  return columns;
}

/** Every run id the page can show, newest first: run rows, then runs known only from tasks. */
export function runIds(runs: readonly RunRowLike[], tasks: readonly TaskRowLike[]): string[] {
  const newest = new Map<string, number>();
  for (const r of runs) newest.set(r.runId, Math.max(newest.get(r.runId) ?? 0, tsMs(r.createdAt)));
  for (const t of tasks) if (t.runId && !newest.has(t.runId)) newest.set(t.runId, tsMs(t.createdAt));
  return [...newest].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).map(([id]) => id);
}

/** The newest run (a run row, or else a task's run), or null before any run exists. */
export function latestRunId(runs: readonly RunRowLike[], tasks: readonly TaskRowLike[]): string | null {
  return runIds(runs, tasks)[0] ?? null;
}

/** A task's one-line detail: the error of a failed task, else its result. */
export function taskDetail(task: TaskRowLike): string {
  return task.result ?? '';
}

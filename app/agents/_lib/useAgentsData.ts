'use client';

import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from '@/lib/spacetime/bindings';

// Every live subscription /agents reads (the brand kit included), plus the agent API's /health (which database the API
// writes, and whether it has the agent tables). The agent tables are subscribed only once /health
// says they exist (or /health can't be read): B's demo database doesn't have them.

/** The fields of GET /api/agent/health this page uses (docs/AGENT_API.md). */
export interface AgentHealth {
  db_label: string;
  db_name: string;
  db_uri: string;
  is_local: boolean;
  mode: 'test' | 'live';
  runs_allowed: boolean;
  run_slot_free: boolean;
  blocked_reason: string;
  browser_db_name: string;
  browser_uri: string;
  browser_matches: boolean;
  spacetime_ok: boolean;
  agent_tables: boolean;
}

async function fetchHealth(): Promise<AgentHealth> {
  const res = await fetch('/api/agent/health', { cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: AgentHealth; error?: string } | null;
  if (!res.ok || !body?.ok || !body.data) throw new Error(body?.error ?? `GET /api/agent/health: HTTP ${res.status}`);
  return body.data;
}

export function useAgentsData() {
  const conn = useSpacetimeDB();
  const health = useQuery({ queryKey: ['agent-health'], queryFn: fetchHealth, refetchInterval: 15_000, retry: 1 });
  // Wait for /health before subscribing; if it can't be read, subscribe anyway and let the rows show.
  // A /health that couldn't reach SpacetimeDB says nothing about the tables, and once seen they stay.
  const seen = useRef(false);
  if (health.data?.agent_tables) seen.current = true;
  const agentTables = seen.current || (health.data ? health.data.agent_tables || !health.data.spacetime_ok : health.isError);
  const [agents, agentsReady] = useTable(tables.agent, { enabled: agentTables });
  const [messages, messagesReady] = useTable(tables.agentMessage, { enabled: agentTables });
  const [jobs, jobsReady] = useTable(tables.ingestJob, { enabled: agentTables });
  const [brandKits] = useTable(tables.brandKit, { enabled: agentTables });
  const [tasks, tasksReady] = useTable(tables.task);
  const [runs, runsReady] = useTable(tables.run);
  return { conn, health, agentTables, agents, agentsReady, messages, messagesReady, jobs, jobsReady, brandKit: brandKits[0] ?? null, tasks, tasksReady, runs, runsReady };
}

export type AgentsData = ReturnType<typeof useAgentsData>;

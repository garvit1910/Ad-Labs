import type { SupabaseClient } from '@supabase/supabase-js';
import { connectSpacetime, resolveSpacetimeTarget, type Spacetime, type SpacetimeTarget } from './spacetime-http';
import { serviceSupabase } from './supabase';
import { DEMO_DATABASE, DEMO_TARGET, runsAllowed } from './targets';

// The database the browser bundle subscribes to: only NEXT_PUBLIC_* reach the client, so the
// server's SPACETIMEDB_* fallback in lib/spacetime/config.ts doesn't apply there.
const browserTarget = () => ({
  uri: (process.env.NEXT_PUBLIC_SPACETIMEDB_URI || DEMO_TARGET.uri).replace(/\/$/, ''),
  dbName: process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME || DEMO_TARGET.dbName,
});

/*
 * Server-side state for the agents' HTTP API (app/api/agent/**, docs/AGENT_API.md): which database
 * the routes act on, the mode, and one SpacetimeDB connection and Supabase client per process.
 * The target comes from SPACETIMEDB_URI / SPACETIMEDB_DB_NAME, which the dev:local and dev:live
 * scripts set explicitly; the browser's NEXT_PUBLIC_* pair is reported so a mismatch shows.
 */

export type AgentMode = 'test' | 'live';

/** test (the default): refreshes are dry and distill never runs. live: only `npm run dev:live` sets it. */
export const agentMode = (): AgentMode => (process.env.ADLAB_AGENT_MODE?.trim() === 'live' ? 'live' : 'test');

export const agentTarget = (): SpacetimeTarget => resolveSpacetimeTarget();

// On globalThis so Next's dev reloads keep one identity per process instead of one per request.
type Memo = { spacetime?: Promise<Spacetime>; supabase?: SupabaseClient };
const memo: Memo = ((globalThis as { __adlabAgentRuntime?: Memo }).__adlabAgentRuntime ??= {});

export function getSpacetime(): Promise<Spacetime> {
  memo.spacetime ??= connectSpacetime().catch((err: unknown) => {
    memo.spacetime = undefined;
    throw err;
  });
  return memo.spacetime;
}

/** Drops the memoized connection, e.g. after a 401, so the next call mints a new identity. */
export function resetSpacetime(): void {
  memo.spacetime = undefined;
}

export function getSupabase(): SupabaseClient {
  return (memo.supabase ??= serviceSupabase());
}

export interface HealthSnapshot {
  db_label: string;
  db_name: string;
  db_uri: string;
  is_local: boolean;
  mode: AgentMode;
  /** The target policy: never the demo database; only the local bench or the stage database. */
  runs_allowed: boolean;
  /** No run row and no run_round task yet: one generating run per database. */
  run_slot_free: boolean;
  /** Why the Strategist can't start a run, or "". */
  blocked_reason: string;
  runs: string[];
  browser_db_name: string;
  browser_uri: string;
  browser_matches: boolean;
  spacetime_ok: boolean;
  agent_tables: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Never throws: an unreachable database is reported, not raised. */
export async function healthSnapshot(): Promise<HealthSnapshot> {
  const target = agentTarget();
  const allowed = runsAllowed(target);
  const browser = browserTarget();
  let spacetimeOk = false;
  let agentTables = false;
  let runs: string[] = [];
  let occupied = false;
  let error = '';
  try {
    const spacetime = await withTimeout(getSpacetime(), 5_000, 'connect');
    const [runRows, tasks] = await Promise.all([
      withTimeout(spacetime.sql('SELECT * FROM run'), 5_000, 'run query'),
      withTimeout(spacetime.sql('SELECT * FROM task'), 5_000, 'task query'),
    ]);
    spacetimeOk = true;
    runs = [...new Set([...runRows.map((row) => String(row.run_id)), ...tasks.filter((t) => t.kind === 'run_round').map((t) => String(t.run_id))])];
    occupied = runs.length > 0;
    agentTables = await withTimeout(spacetime.sql('SELECT * FROM agent'), 5_000, 'agent query').then(
      () => true,
      () => false,
    );
  } catch (err) {
    error = message(err);
  }
  const blockedReason = !allowed
    ? target.dbName === DEMO_DATABASE
      ? `agent runs are never started on ${DEMO_DATABASE} (B's demo run)`
      : `agent runs only go to the local bench or the stage database, not ${target.dbName}`
    : !spacetimeOk
      ? `SpacetimeDB is unreachable: ${error}`
      : occupied
        ? `${target.dbName} already holds ${runs.join(', ')}; reset the database before a new run`
        : '';
  return {
    db_label: target.label,
    db_name: target.dbName,
    db_uri: target.uri,
    is_local: target.isLocal,
    mode: agentMode(),
    runs_allowed: allowed,
    run_slot_free: spacetimeOk && !occupied,
    blocked_reason: blockedReason,
    runs,
    browser_db_name: browser.dbName,
    browser_uri: browser.uri,
    browser_matches: browser.uri === target.uri && browser.dbName === target.dbName,
    spacetime_ok: spacetimeOk,
    agent_tables: agentTables,
  };
}

'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bot } from 'lucide-react';
import { EyebrowChip } from '@/components/ui/eyebrow-chip';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { databaseLabel, isLocalDatabase } from '@/app/sim/_components/SimProvider';
import { Section } from '@/app/sim/_components/Section';
import { AgentCard } from './_components/AgentCard';
import { IngestJobs } from './_components/IngestJobs';
import { MessageStream } from './_components/MessageStream';
import { TaskBoard } from './_components/TaskBoard';
import { useAgentsData } from './_lib/useAgentsData';
import { AGENT_ORDER, agentCards, jobRows, latestRunId, messageStream, partyName, runIds, taskColumns } from './_lib/selectors';

// /agents: Ad Lab, Scout, Strategist and Copywriter at work. Every row arrives over a SpacetimeDB
// subscription (agent, agent_message, ingest_job, task, run) the moment the agent API writes it.

const ALL = '__all__';

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const selectClass = 'h-7 rounded-md border border-border bg-background px-2 font-mono text-xs';

function AgentsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const data = useAgentsData();
  const { conn, health } = data;
  const now = useNow(5_000);

  const cards = useMemo(() => agentCards(data.agents, data.messages, now), [data.agents, data.messages, now]);
  const runs = useMemo(() => runIds(data.runs, data.tasks), [data.runs, data.tasks]);
  const requestedRun = params.get('run');
  const boardRun = requestedRun && runs.includes(requestedRun) ? requestedRun : latestRunId(data.runs, data.tasks);
  const columns = useMemo(() => taskColumns(data.tasks, boardRun), [data.tasks, boardRun]);

  const [messageRun, setMessageRun] = useState<string>(ALL);
  const [messageAgent, setMessageAgent] = useState<string>(ALL);
  const stream = useMemo(
    () =>
      messageStream(data.messages, {
        runId: messageRun === ALL ? null : messageRun,
        agentId: messageAgent === ALL ? null : messageAgent,
        agents: data.agents,
      }),
    [data.messages, data.agents, messageRun, messageAgent],
  );
  const messageRuns = useMemo(() => [...new Set(data.messages.map((m) => m.runId))].sort().reverse(), [data.messages]);
  const jobs = useMemo(() => jobRows(data.jobs, data.agents), [data.jobs, data.agents]);

  const h = health.data;
  const noAgentTables = h ? !h.agent_tables : false;

  return (
    <>
      <div
        className={cn(
          'rounded-lg border px-4 py-3 font-mono text-sm font-semibold',
          isLocalDatabase ? 'border-status-success/40 bg-status-success-soft text-status-success' : 'border-status-error/40 bg-status-error-soft text-status-error',
        )}
      >
        {isLocalDatabase ? 'LOCAL' : 'MAINCLOUD'} · {databaseLabel}
        <span className="ml-3 font-sans text-xs font-normal opacity-80">
          {h
            ? `agent API: mode ${h.mode} · ${h.runs_allowed ? 'agent runs allowed' : 'agent runs not allowed'}${h.blocked_reason ? ` · ${h.blocked_reason}` : ''}`
            : health.isError
              ? `agent API health unavailable: ${health.error instanceof Error ? health.error.message : String(health.error)}`
              : 'checking the agent API…'}
        </span>
      </div>
      {h && !h.browser_matches && (
        <div className="rounded-lg border border-status-error/40 bg-status-error-soft px-4 py-3 text-sm font-semibold text-status-error">
          Database mismatch: this page reads {h.browser_db_name} @ {h.browser_uri.replace(/^https?:\/\//, '')}, but the agent API writes{' '}
          {h.db_name} @ {h.db_uri.replace(/^https?:\/\//, '')}. Start the app with npm run dev:local or dev:live so both match.
        </div>
      )}
      <PageHeader
        eyebrow={<EyebrowChip icon={Bot}>Fetch.ai agents · {isLocalDatabase ? 'Local bench' : 'Maincloud'}</EyebrowChip>}
        title="Agents"
        description="Ad Lab, Scout, Strategist and Copywriter at work: every message, Apify job and task, live from SpacetimeDB."
        actions={
          <div className="flex items-center gap-3">
            <Link href="/sim" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Live sim →
            </Link>
            <Link href="/" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Home
            </Link>
          </div>
        }
      />
      {conn.connectionError && (
        <div className="rounded-lg border border-status-error/30 bg-status-error-soft px-4 py-3 text-sm text-status-error">
          Could not reach {databaseLabel}: {conn.connectionError.message}
        </div>
      )}
      {noAgentTables && (
        <div className="rounded-lg border border-status-warning/30 bg-status-warning-soft px-4 py-3 text-sm text-status-warning">
          This database has no agent tables (use npm run dev:local or dev:live). The task board below still shows its tasks.
        </div>
      )}

      {!noAgentTables && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.agentTables && !data.agentsReady
              ? AGENT_ORDER.map((id) => <Skeleton key={id} className="h-36 w-full" />)
              : cards.map((agent) => <AgentCard key={agent.agentId} agent={agent} />)}
          </div>

          <Section
            title="Messages"
            hint={
              <span className="flex flex-wrap items-center gap-2">
                <select aria-label="Run" className={selectClass} value={messageRun} onChange={(e) => setMessageRun(e.target.value)}>
                  <option value={ALL}>all runs</option>
                  {messageRuns.map((r) => (
                    <option key={r || 'none'} value={r}>
                      {r || 'outside a run'}
                    </option>
                  ))}
                </select>
                <select aria-label="Agent" className={selectClass} value={messageAgent} onChange={(e) => setMessageAgent(e.target.value)}>
                  <option value={ALL}>every party</option>
                  {[...AGENT_ORDER, 'user'].map((id) => (
                    <option key={id} value={id}>
                      {partyName(id, data.agents)}
                    </option>
                  ))}
                </select>
                <span>{conn.isActive ? `${stream.length} shown · live` : 'connecting…'}</span>
              </span>
            }
          >
            <MessageStream messages={stream} empty={data.messagesReady ? 'No messages yet. They appear here as the agents talk.' : 'Loading…'} />
          </Section>

          <Section title="Ingest jobs" hint="Apify refreshes Scout started; in test mode they are dry runs">
            <IngestJobs jobs={jobs} now={now} empty={data.jobsReady ? 'No ingest jobs yet.' : 'Loading…'} />
          </Section>
        </>
      )}

      <Section
        title="Task board"
        hint={
          runs.length > 0 ? (
            <select
              aria-label="Run"
              className={selectClass}
              value={boardRun ?? ''}
              onChange={(e) => router.replace(`/agents?run=${encodeURIComponent(e.target.value)}`)}
            >
              {runs.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          ) : data.tasksReady ? (
            'no runs yet'
          ) : (
            'connecting…'
          )
        }
      >
        <TaskBoard columns={columns} />
      </Section>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <AgentsPage />
    </Suspense>
  );
}

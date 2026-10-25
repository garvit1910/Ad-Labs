'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bot, ChevronRight } from 'lucide-react';
import { EyebrowChip } from '@/components/ui/eyebrow-chip';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { SPACETIMEDB_DB_NAME, SPACETIMEDB_URI } from '@/lib/spacetime/config';
import { databaseLabel, isLocalDatabase } from '@/app/sim/_components/SimProvider';
import { Section } from '@/app/sim/_components/Section';
import { ChatRoom } from './_components/ChatRoom';
import { ChatThread, type TypingParty } from './_components/ChatThread';
import { IngestJobs } from './_components/IngestJobs';
import { ParticipantList } from './_components/ParticipantList';
import { SessionList } from './_components/SessionList';
import { TaskBoard } from './_components/TaskBoard';
import { chatSessions, chatThread, roomName, sessionIds, tidy } from './_lib/chat';
import { useAgentsData } from './_lib/useAgentsData';
import { useReplay } from './_lib/useReplay';
import { AGENT_ORDER, agentCards, jobRows, latestRunId, partyName, runIds, taskColumns } from './_lib/selectors';

// /agents: the agent room. Ad Lab, Scout, Strategist and Copywriter talking, Band-style: runs as
// sessions, agent_message rows as chat bubbles, the agents as participants. Every row arrives over
// a SpacetimeDB subscription (agent, agent_message, ingest_job, task, run) the moment the agent API
// writes it. The task board and Apify jobs sit under "Behind the scenes".

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

/** A session counts as live while an agent works or its last message is this recent. */
const LIVE_MS = 3 * 60_000;

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
  const jobs = useMemo(() => jobRows(data.jobs, data.agents), [data.jobs, data.agents]);

  const ids = useMemo(() => sessionIds(data.messages, data.runs), [data.messages, data.runs]);
  const sessions = useMemo(() => chatSessions(data.messages, ids, data.agents), [data.messages, ids, data.agents]);
  // Follows the newest session until you pick one.
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = picked && sessions.some((s) => s.id === picked) ? picked : (sessions[0]?.id ?? null);
  const session = sessions.find((s) => s.id === selectedId) ?? null;

  const [partyFilter, setPartyFilter] = useState<string>(ALL);
  const [showPings, setShowPings] = useState(true);
  const thread = useMemo(() => chatThread(data.messages, ids, selectedId, data.agents), [data.messages, ids, selectedId, data.agents]);
  const filtered = useMemo(
    () =>
      thread.filter(
        (b) => (showPings || b.kind !== 'progress') && (partyFilter === ALL || b.from === partyFilter || b.to.includes(partyFilter)),
      ),
    [thread, showPings, partyFilter],
  );
  const replay = useReplay(filtered);
  const bubbles = replay.active ? filtered.slice(0, replay.shown) : filtered;

  const anyWorking = cards.some((c) => c.status === 'working');
  const newest = sessions[0];
  const liveId = newest && (anyWorking || now - newest.lastMs < LIVE_MS) ? newest.id : null;
  const typing: TypingParty[] = replay.active
    ? replay.typing
      ? [{ id: replay.typing, name: roomName(replay.typing, data.agents), step: '' }]
      : []
    : selectedId !== null && selectedId === liveId
      ? cards.filter((c) => c.status === 'working').map((c) => ({ id: c.agentId, name: roomName(c.agentId, data.agents), step: tidy(c.currentStep) }))
      : [];

  const select = (id: string) => {
    replay.exit();
    setPicked(id);
  };
  const startReplay = () => {
    if (selectedId) replay.start(selectedId);
  };
  // /agents?replay=1 plays the newest session as soon as it loads (a link to open on stage).
  const autoReplayed = useRef(false);
  const autoReplay = params.get('replay') === '1';
  const { start: startReplayFor } = replay;
  useEffect(() => {
    if (!autoReplay || autoReplayed.current || !selectedId || thread.length === 0) return;
    autoReplayed.current = true;
    startReplayFor(selectedId);
  }, [autoReplay, selectedId, thread.length, startReplayFor]);

  const h = health.data;
  const noAgentTables = h ? h.spacetime_ok && !h.agent_tables && !data.agentTables : false;
  // Compared here, against the database this browser bundle subscribes to (only NEXT_PUBLIC_* reach it),
  // because the server can't see what the client was built with.
  const browserUri = SPACETIMEDB_URI.replace(/\/$/, '');
  const mismatch = !!h && (h.db_name !== SPACETIMEDB_DB_NAME || h.db_uri !== browserUri);

  return (
    <>
      <PageHeader
        eyebrow={<EyebrowChip icon={Bot}>Fetch.ai agents · {isLocalDatabase ? 'Local bench' : 'Maincloud'}</EyebrowChip>}
        title="Agent room"
        description="Ad Lab, Scout, Strategist and Copywriter coordinating over Fetch.ai uAgents, live from SpacetimeDB."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <span
              title={h ? `agent API: mode ${h.mode} · ${h.runs_allowed ? 'agent runs allowed' : 'agent runs not allowed'}${h.blocked_reason ? ` · ${h.blocked_reason}` : ''}` : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold',
                isLocalDatabase ? 'border-status-success/40 text-status-success' : 'border-status-error/40 text-status-error',
              )}
            >
              <span className={cn('size-1.5 rounded-full', conn.isActive ? 'bg-current' : 'bg-muted-foreground')} />
              {isLocalDatabase ? 'LOCAL' : 'MAINCLOUD'} · {databaseLabel}
              {h && ` · ${h.mode}`}
            </span>
            <Link href="/sim" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Live sim →
            </Link>
            <Link href="/" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Home
            </Link>
          </div>
        }
      />
      {h && mismatch && (
        <div className="rounded-lg border border-status-error/40 bg-status-error-soft px-4 py-3 text-sm font-semibold text-status-error">
          Database mismatch: this page reads {SPACETIMEDB_DB_NAME} @ {browserUri.replace(/^https?:\/\//, '')}, but the agent API writes{' '}
          {h.db_name} @ {h.db_uri.replace(/^https?:\/\//, '')}. Start the app with npm run dev:local or dev:live so both match.
        </div>
      )}
      {!h && health.isError && (
        <div className="rounded-lg border border-status-warning/30 bg-status-warning-soft px-4 py-3 text-sm text-status-warning">
          Agent API health unavailable: {health.error instanceof Error ? health.error.message : String(health.error)}
        </div>
      )}
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

      {!noAgentTables &&
        (data.agentTables && !data.messagesReady ? (
          <Skeleton className="h-[600px] w-full" />
        ) : (
          <ChatRoom>
            <SessionList
              sessions={sessions}
              selected={selectedId}
              liveId={liveId}
              now={now}
              onSelect={select}
              onReplay={startReplay}
              replayDisabled={!selectedId || replay.active}
            />
            <ChatThread
              session={session}
              bubbles={bubbles}
              typing={typing}
              replay={replay}
              onReplay={startReplay}
              partyFilter={partyFilter}
              onPartyFilter={setPartyFilter}
              partyOptions={[{ id: ALL, name: 'Everyone' }, ...[...AGENT_ORDER, 'user'].map((id) => ({ id, name: roomName(id, data.agents) }))]}
              showPings={showPings}
              onShowPings={setShowPings}
              empty={conn.isActive ? 'No messages yet. Ask Ad Lab something on ASI:One and the agents start talking here.' : 'Connecting…'}
            />
            <ParticipantList agents={cards} />
          </ChatRoom>
        ))}

      <details className="group rounded-xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-semibold">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
          Behind the scenes
          <span className="font-normal text-muted-foreground">task board and Apify jobs</span>
        </summary>
        <div className="flex flex-col gap-4 border-t border-border p-4">
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
          {!noAgentTables && (
            <Section title="Ingest jobs" hint="Apify refreshes Scout started; in test mode they are dry runs">
              <IngestJobs jobs={jobs} now={now} empty={data.jobsReady ? 'No ingest jobs yet.' : 'Loading…'} />
            </Section>
          )}
        </div>
      </details>
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

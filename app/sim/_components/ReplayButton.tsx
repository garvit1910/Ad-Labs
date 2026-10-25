'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEFAULT_DAY_MS, REPLAY_SPEEDS, replaySource, type ReplayInfo, type ReplayState } from '../_lib/replay';

// Replays the selected (finished) run from the Jev cache at a chosen pace, through
// /api/sim/replay. The replay is a new run, so the page switches to it and fills live.

async function call<T>(method: 'GET' | 'POST' | 'DELETE', body?: object): Promise<T> {
  const res = await fetch('/api/sim/replay', {
    method,
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function progress(replay: ReplayState): string {
  const rounds = replay.roundsTotal ? ` · round ${Math.min(replay.roundsDone + 1, replay.roundsTotal)} of ${replay.roundsTotal}` : '';
  return `Replaying ${replay.from}${rounds}`;
}

export function ReplayButton({
  runId,
  runStatus,
  runs,
  viewing,
  onWatch,
}: {
  /** The run the page shows, once its row exists. */
  runId: string | null;
  runStatus: string | null;
  runs: readonly { runId: string; status: string }[];
  /** The run the page is on (?run=), even before its row exists. */
  viewing: string | null;
  onWatch: (runId: string) => void;
}) {
  const client = useQueryClient();
  const [dayMs, setDayMs] = useState<number>(DEFAULT_DAY_MS);
  const source = replaySource(runId, runStatus, runs);
  const info = useQuery({
    queryKey: ['sim-replay'],
    queryFn: () => call<ReplayInfo>('GET'),
    refetchInterval: (query) => (query.state.data?.replay?.status === 'running' ? 1_500 : 10_000),
    retry: 1,
  });
  const start = useMutation({
    mutationFn: () => call<{ replay: ReplayState }>('POST', { from: source, day_ms: dayMs }),
    onSuccess: ({ replay }) => {
      client.setQueryData<ReplayInfo>(['sim-replay'], (old) => (old ? { ...old, replay } : old));
      onWatch(replay.as);
    },
  });
  const stop = useMutation({
    mutationFn: () => call<{ replay: ReplayState | null }>('DELETE'),
    onSuccess: () => client.invalidateQueries({ queryKey: ['sim-replay'] }),
  });

  const replay = info.data?.replay ?? null;
  const running = replay?.status === 'running';

  // Back to the source run after a Stop, or when the replay ended before its run existed (the page
  // would otherwise wait on a run that never comes).
  const lastStatus = useRef(replay?.status);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = replay?.status;
    if (!replay || was !== 'running' || replay.status === 'running' || viewing !== replay.as) return;
    if (replay.status === 'stopped' || (replay.status === 'failed' && !runId)) onWatch(replay.from);
  }, [replay, viewing, runId, onWatch]);
  const allowed = info.data?.allowed ?? false;
  const canStart = allowed && !running && !!source && !start.isPending;
  const why = !info.data
    ? 'checking whether this server can replay…'
    : !allowed
      ? info.data.reason
      : running
        ? 'a replay is already running'
        : !source
          ? `only a finished run can be replayed${runId ? ` (${runId} is ${runStatus})` : ''}`
          : `replay ${source} from the Jev cache as a new run (identical numbers, no Jev calls)`;
  const error = start.error ?? stop.error;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {running ? (
        <>
          <span className="font-mono text-xs text-muted-foreground">{progress(replay)}</span>
          {viewing !== replay.as && (
            <Button size="sm" variant="outline" onClick={() => onWatch(replay.as)}>
              Watch
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => stop.mutate()} disabled={stop.isPending} title="Stop the replay">
            <Square />
            Stop
          </Button>
        </>
      ) : (
        <>
          <select
            aria-label="Replay speed"
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs"
            value={dayMs}
            onChange={(e) => setDayMs(Number(e.target.value))}
          >
            {REPLAY_SPEEDS.map((speed) => (
              <option key={speed.dayMs} value={speed.dayMs}>
                {speed.label}
              </option>
            ))}
          </select>
          {/* A disabled button gets no pointer events, so the reason lives on its wrapper. */}
          <span title={why} className="inline-flex">
            <Button size="sm" onClick={() => start.mutate()} disabled={!canStart}>
              <Play />
              {start.isPending ? 'Starting…' : source && source !== runId ? `Replay ${source}` : 'Replay run'}
            </Button>
          </span>
          {info.data && !allowed && <span className="font-mono text-xs text-muted-foreground">replay: local database only</span>}
          {/* The tooltip alone reads as a broken button, so say why it is off. */}
          {info.data && allowed && !source && <span className="font-mono text-xs text-muted-foreground">{why}</span>}
        </>
      )}
      {!running && replay && (
        <span className="font-mono text-xs text-muted-foreground" title={replay.log.slice(-8).join('\n')}>
          last replay {replay.as}: {replay.status === 'done' ? replay.message || 'done' : `${replay.status} · ${replay.message}`}
          {viewing !== replay.as && replay.status === 'done' && (
            <button type="button" className="ml-2 underline underline-offset-4 hover:text-foreground" onClick={() => onWatch(replay.as)}>
              view
            </button>
          )}
        </span>
      )}
      {error && <span className="font-mono text-xs text-status-error">{error instanceof Error ? error.message : String(error)}</span>}
    </div>
  );
}

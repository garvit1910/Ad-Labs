'use client';

import { Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatSession } from '../_lib/chat';
import { ago } from '../_lib/selectors';

// The room's left rail: one session per run, newest activity first. Below lg it's a <select>.
export function SessionList({
  sessions,
  selected,
  liveId,
  now,
  onSelect,
  onReplay,
  replayDisabled,
}: {
  sessions: readonly ChatSession[];
  selected: string | null;
  liveId: string | null;
  now: number;
  onSelect: (id: string) => void;
  onReplay: () => void;
  replayDisabled: boolean;
}) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border p-3 lg:hidden">
        <select
          aria-label="Session"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
          value={selected ?? ''}
          onChange={(e) => onSelect(e.target.value)}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <aside className="hidden min-h-0 flex-col border-r border-border lg:flex">
        <div className="flex h-14 shrink-0 items-center border-b border-border px-4 text-sm font-semibold">Sessions</div>
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
          {sessions.length === 0 && <li className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet</li>}
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className={cn(
                  'flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors',
                  s.id === selected ? 'bg-secondary' : 'hover:bg-secondary/50',
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {s.id === liveId && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-status-success" aria-label="live" />}
                  <span className="truncate">{s.label}</span>
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{s.preview}</span>
                <span className="flex justify-between text-[10.5px] text-muted-foreground/80">
                  <span>{s.count} messages</span>
                  <span>{ago(s.lastMs, now)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="shrink-0 border-t border-border p-2">
          <button
            type="button"
            onClick={onReplay}
            disabled={replayDisabled}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-secondary disabled:pointer-events-none disabled:opacity-50"
          >
            <Play className="size-3.5" />
            Replay this session
          </button>
        </div>
      </aside>
    </>
  );
}

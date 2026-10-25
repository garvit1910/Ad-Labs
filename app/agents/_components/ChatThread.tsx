'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ExternalLink, FastForward, Forward, LayoutList, Pause, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type ChatBubble, type ChatSession, mentionClass } from '../_lib/chat';
import { AGENT_ORDER, clockTime, prettyPayload } from '../_lib/selectors';
import { SPEEDS, type Replay } from '../_lib/useReplay';
import { PartyAvatar } from './PartyAvatar';

export interface TypingParty {
  id: string;
  name: string;
  step: string;
}

const PINNED_PX = 80;
const ASI_ONE_URL = 'https://asi1.ai';

// The room's centre: the session's bubbles oldest first, following the bottom while you're there,
// a typing row for agents at work, and either the ASI:One link or the replay controls underneath.
export function ChatThread({
  session,
  bubbles,
  typing,
  replay,
  onReplay,
  partyFilter,
  onPartyFilter,
  partyOptions,
  showPings,
  onShowPings,
  empty,
}: {
  session: ChatSession | null;
  bubbles: readonly ChatBubble[];
  typing: readonly TypingParty[];
  replay: Replay;
  onReplay: () => void;
  partyFilter: string;
  onPartyFilter: (id: string) => void;
  partyOptions: readonly { id: string; name: string }[];
  showPings: boolean;
  onShowPings: (on: boolean) => void;
  empty: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const seen = useRef(0);

  const toBottom = (smooth: boolean) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  // A new session (or a replay restart) starts at the bottom.
  useLayoutEffect(() => {
    toBottom(false);
    setPinned(true);
    setUnseen(false);
    seen.current = 0;
  }, [session?.id, replay.active]);

  useEffect(() => {
    const grew = bubbles.length > seen.current;
    seen.current = bubbles.length;
    if (pinned) toBottom(true);
    else if (grew) setUnseen(true);
  }, [bubbles.length, typing.length, pinned]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_PX;
    setPinned(atBottom);
    if (atBottom) setUnseen(false);
  };

  const participants = AGENT_ORDER.filter((id) => bubbles.some((b) => b.from === id || b.to.includes(id)));

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold"># {session?.runId ?? (session ? 'open-chat' : 'no session')}</div>
        </div>
        <div className="hidden -space-x-1.5 sm:flex">
          {['user', ...participants].map((id) => (
            <PartyAvatar key={id} id={id} size="sm" className="ring-2 ring-card" />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            aria-label="Participant"
            className="h-7 rounded-md border border-border bg-background px-2 text-xs"
            value={partyFilter}
            onChange={(e) => onPartyFilter(e.target.value)}
          >
            {partyOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onShowPings(!showPings)}
            aria-pressed={showPings}
            title="Show progress pings"
            className={cn(
              'hidden h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs sm:inline-flex',
              showPings ? 'bg-secondary text-foreground' : 'text-muted-foreground',
            )}
          >
            <LayoutList className="size-3.5" />
            Pings
          </button>
          {!replay.active && (
            <button
              type="button"
              onClick={onReplay}
              disabled={!session}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Play className="size-3.5" />
              Replay
            </button>
          )}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="absolute inset-0 overflow-y-auto px-4 py-4">
          {bubbles.length === 0 && typing.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{replay.active ? 'Replay starting…' : empty}</div>
          ) : (
            <ol className="flex flex-col gap-4">
              {bubbles.map((b) => (
                <Bubble key={b.id} bubble={b} />
              ))}
              {typing.map((t) => (
                <li key={t.id} className="flex items-center gap-3 animate-in fade-in">
                  <PartyAvatar id={t.id} />
                  <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                    <Dots />
                    <span>
                      <span className="font-medium text-foreground">{t.name}</span> {t.step ? `is working · ${t.step}` : 'is typing…'}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        {unseen && (
          <button
            type="button"
            onClick={() => toBottom(true)}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs shadow-lg"
          >
            <ArrowDown className="size-3.5" />
            New messages
          </button>
        )}
      </div>

      <footer className="shrink-0 border-t border-border p-3">
        {replay.active ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="mr-1 inline-flex items-center gap-1.5 rounded-full bg-violet-500/15 px-2 py-0.5 font-medium text-violet-300">
              <span className={cn('size-1.5 rounded-full bg-violet-300', replay.playing && 'animate-pulse')} />
              Replay
            </span>
            <button type="button" onClick={replay.toggle} className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 hover:bg-secondary">
              {replay.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              {replay.playing ? 'Pause' : replay.shown >= replay.total ? 'Again' : 'Play'}
            </button>
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => replay.setSpeed(s)}
                  className={cn('h-7 px-2', s === replay.speed ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {s}×
                </button>
              ))}
            </div>
            <button type="button" onClick={replay.skip} className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 hover:bg-secondary">
              <FastForward className="size-3.5" />
              Skip to end
            </button>
            <span className="tabular-nums text-muted-foreground">
              {replay.shown} / {replay.total}
            </span>
            <button type="button" onClick={replay.exit} className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
              Exit replay
            </button>
          </div>
        ) : (
          <a
            href={ASI_ONE_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/50 px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <span>Talk to Ad Lab on ASI:One to start a new session…</span>
            <ExternalLink className="size-4 shrink-0" />
          </a>
        )}
      </footer>
    </section>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-0.5">
      {[0, 150, 300].map((d) => (
        <span key={d} className="size-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}

function Bubble({ bubble: b }: { bubble: ChatBubble }) {
  const [open, setOpen] = useState(false);
  const fromUser = b.from === 'user';
  const hasPayload = !!b.payload && b.payload !== '{}';
  return (
    <li className={cn('flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300', fromUser && 'flex-row-reverse')}>
      <PartyAvatar id={b.from} />
      <div className={cn('flex min-w-0 max-w-[78%] flex-col gap-1', fromUser && 'items-end')}>
        <div className={cn('flex items-baseline gap-2 text-xs', fromUser && 'flex-row-reverse')}>
          <span className="font-semibold text-foreground">{b.fromName}</span>
          <span className="tabular-nums text-muted-foreground" title={new Date(b.createdMs).toISOString()}>
            {clockTime(b.createdMs)}
          </span>
          {b.kind === 'progress' && <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">ping</span>}
        </div>
        <div
          className={cn(
            'rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
            fromUser ? 'rounded-tr-sm bg-violet-500/20 text-foreground' : 'rounded-tl-sm bg-secondary/70 text-foreground',
          )}
        >
          {b.toNames.map((name, i) => (
            <span key={name} className={cn('mr-1.5 inline-block rounded-md bg-background/60 px-1.5 py-px text-xs font-semibold', mentionClass(b.to[i]))}>
              @{name}
            </span>
          ))}
          {b.card ? (
            <span className="mt-1.5 flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2">
              <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300">Card</span>
              <span className="font-medium">{b.card}</span>
            </span>
          ) : (
            <span>{b.text}</span>
          )}
        </div>
        <div className={cn('flex items-center gap-3 text-[11px] text-muted-foreground', fromUser && 'flex-row-reverse')}>
          {b.forwardedTo.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Forward className="size-3" />
              Ad Lab forwarded to {b.forwardedTo.join(', ')}
            </span>
          )}
          {hasPayload && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="hover:text-foreground">
              {open ? 'hide payload' : 'view payload'}
            </button>
          )}
        </div>
        {open && (
          <pre className="max-h-64 w-full overflow-auto rounded-md border border-border bg-background/50 p-2 font-mono text-[10.5px] leading-relaxed">
            {prettyPayload(b.payload)}
          </pre>
        )}
      </div>
    </li>
  );
}

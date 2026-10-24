'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { FlaskConical } from 'lucide-react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { Button } from '@/components/ui/button';
import { EyebrowChip } from '@/components/ui/eyebrow-chip';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { reducers, tables } from '@/lib/spacetime/bindings';
import type { Task } from '@/lib/spacetime/bindings/types';
import { Section } from '../_components/Section';
import { databaseLabel, isLocalDatabase } from '../_components/SimProvider';
import { latestRun } from '../_lib/selectors';

// The B5 test bench: which database this page reads, live row counts for all 14 tables, the shared
// task board, and a button that queues the next run_round. The button only works against a local
// database; against Maincloud this page is read-only.

const STATUS_TONE: Record<string, StatusPillTone> = { queued: 'queued', claimed: 'active', done: 'connected', failed: 'failed' };
const STATUSES = ['queued', 'claimed', 'done', 'failed'] as const;

function useCounts() {
  const counts: [string, number, boolean][] = [];
  const add = (name: string, [rows, ready]: readonly [readonly unknown[], boolean]) => counts.push([name, rows.length, ready]);
  // A's tables, then B's, then the shared task board.
  add('brand', useTable(tables.brand));
  add('concept', useTable(tables.concept));
  add('segment', useTable(tables.segment));
  add('arm', useTable(tables.arm));
  add('creative', useTable(tables.creative));
  add('product', useTable(tables.product));
  add('creative_perception', useTable(tables.creativePerception));
  add('run', useTable(tables.run));
  add('round', useTable(tables.round));
  add('shopper', useTable(tables.shopper));
  add('decision', useTable(tables.decision));
  add('arm_stat', useTable(tables.armStat));
  add('learning', useTable(tables.learning));
  add('task', useTable(tables.task));
  return counts;
}

export default function SimDevPage() {
  const conn = useSpacetimeDB();
  const counts = useCounts();
  const [tasks] = useTable(tables.task);
  const [runs] = useTable(tables.run);
  const [rounds] = useTable(tables.round);
  const enqueue = useReducer(reducers.enqueueTask);
  const [message, setMessage] = useState<string | null>(null);

  // The next run_round: the newest run's next round, or round 0 of a new local run once it is done.
  const next = useMemo(() => {
    const run = latestRun(runs);
    if (!run) return { runId: 'run_local', round: 0 };
    const done = rounds.filter((r) => r.runId === run.runId);
    const last = done.reduce((m, r) => Math.max(m, r.round), -1);
    if (last < run.roundsPlanned) return { runId: run.runId, round: last + 1 };
    return { runId: `run_local_${runs.length + 1}`, round: 0 };
  }, [runs, rounds]);
  const nextTaskId = `tsk_run_${next.runId}_r${next.round}`;
  const alreadyQueued = tasks.some((t) => t.taskId === nextTaskId);

  const queue = async () => {
    setMessage(null);
    try {
      await enqueue({ taskId: nextTaskId, kind: 'run_round', payloadJson: JSON.stringify({ run_id: next.runId, round: next.round }) });
      setMessage(`queued ${nextTaskId}`);
    } catch (err) {
      setMessage(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const byStatus = (s: string) =>
    tasks.filter((t) => t.status === s).sort((a, b) => Number(b.updatedAt.microsSinceUnixEpoch - a.updatedAt.microsSinceUnixEpoch));

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
          {isLocalDatabase ? 'test bench: safe to write' : 'shared database: this page never writes to it'}
        </span>
      </div>
      <PageHeader
        eyebrow={<EyebrowChip icon={FlaskConical}>B5 test bench</EyebrowChip>}
        title="Sim dev"
        description="Live row counts, the task board, and a way to queue the next round on the local bench."
        actions={
          <Link href="/sim" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            ← Live sim
          </Link>
        }
      />
      {conn.connectionError && (
        <div className="rounded-lg border border-status-error/30 bg-status-error-soft px-4 py-3 text-sm text-status-error">
          Could not reach {databaseLabel}: {conn.connectionError.message}
        </div>
      )}

      <Section title="Tables" hint={conn.isActive ? 'live' : 'connecting…'}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {counts.map(([name, n, ready]) => (
            <div key={name} className="rounded-lg border border-border bg-background/50 px-3 py-2">
              <div className="truncate font-mono text-[11px] text-muted-foreground">{name}</div>
              <div className="font-mono text-lg font-semibold tabular-nums">{ready ? n.toLocaleString() : '…'}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Task board"
        hint={
          <span className="flex flex-wrap items-center gap-3">
            {message && <span className="font-mono">{message}</span>}
            <Button
              size="sm"
              onClick={queue}
              disabled={!isLocalDatabase || !conn.isActive || alreadyQueued}
              title={isLocalDatabase ? nextTaskId : 'Only on a local database'}
            >
              Queue next round
            </Button>
            <span className="font-mono text-muted-foreground">
              {isLocalDatabase ? `${next.runId} · round ${next.round}${alreadyQueued ? ' (already queued)' : ''}` : 'disabled on Maincloud'}
            </span>
          </span>
        }
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {STATUSES.map((s) => (
            <div key={s} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <StatusPill tone={STATUS_TONE[s]!}>{s}</StatusPill>
                <span className="font-mono text-xs text-muted-foreground">{byStatus(s).length}</span>
              </div>
              <ul className="flex max-h-[420px] flex-col gap-1.5 overflow-y-auto">
                {byStatus(s).map((t) => (
                  <TaskCard key={t.taskId} task={t} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function TaskCard({ task }: { task: Task }) {
  const detail = task.result ?? '';
  return (
    <li className="rounded-md border border-border bg-background/50 px-2.5 py-1.5 text-xs">
      <div className="truncate font-mono text-foreground" title={task.taskId}>{task.taskId}</div>
      <div className="line-clamp-2 break-all font-mono text-[10.5px] text-muted-foreground" title={task.payload}>
        {task.kind} · {task.payload}
        {task.claimedBy ? ` · ${task.claimedBy}` : ''}
      </div>
      {detail && (
        <div className={cn('mt-0.5 line-clamp-2 text-[10.5px]', task.status === 'failed' ? 'text-status-error' : 'text-muted-foreground')} title={detail}>
          {detail}
        </div>
      )}
    </li>
  );
}

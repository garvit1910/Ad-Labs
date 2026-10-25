'use client';

import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { TASK_STATUSES, TASK_TONE, type TaskRowLike, type TaskStatus, taskDetail } from '../_lib/selectors';

// The shared task board for one run: queued, claimed, done and failed columns, like B's /sim/dev
// board (whose TaskCard isn't exported, so this is A's own).
export function TaskBoard({ columns }: { columns: Record<TaskStatus, readonly TaskRowLike[]> }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {TASK_STATUSES.map((s) => (
        <div key={s} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <StatusPill tone={TASK_TONE[s]}>{s}</StatusPill>
            <span className="font-mono text-xs text-muted-foreground">{columns[s].length}</span>
          </div>
          <ul className="flex max-h-[420px] flex-col gap-1.5 overflow-y-auto">
            {columns[s].map((t) => (
              <TaskCard key={t.taskId} task={t} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TaskCard({ task }: { task: TaskRowLike }) {
  const detail = taskDetail(task);
  return (
    <li className="rounded-md border border-border bg-background/50 px-2.5 py-1.5 text-xs">
      <div className="truncate font-mono text-foreground" title={task.taskId}>
        {task.taskId}
      </div>
      <div className="font-mono text-[10.5px] text-muted-foreground">
        {task.kind}
        {task.claimedBy ? ` · claimed by ${task.claimedBy}` : ''}
      </div>
      {detail && (
        <div
          className={cn('mt-0.5 line-clamp-2 break-all text-[10.5px]', task.status === 'failed' ? 'text-status-error' : 'text-muted-foreground')}
          title={detail}
        >
          {detail}
        </div>
      )}
    </li>
  );
}

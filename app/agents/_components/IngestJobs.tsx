'use client';

import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { type IngestJobView, ago } from '../_lib/selectors';

// The ingest_job rows: one per Apify job Scout started (or, in test mode, would have started).
export function IngestJobs({ jobs, now, empty }: { jobs: readonly IngestJobView[]; now: number; empty: string }) {
  if (jobs.length === 0) return <div className="py-6 text-center text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="sticky top-0 bg-card text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Target</th>
            <th className="py-1.5 pr-3 font-medium">Actor</th>
            <th className="py-1.5 pr-3 font-medium">Status</th>
            <th className="py-1.5 pr-3 text-right font-medium">Items</th>
            <th className="py-1.5 pr-3 font-medium">By</th>
            <th className="py-1.5 pr-3 font-medium">Error</th>
            <th className="py-1.5 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {jobs.map((j) => (
            <tr key={j.jobId} title={j.jobId}>
              <td className="py-1.5 pr-3 font-medium">{j.target}</td>
              <td className="py-1.5 pr-3 font-mono text-[10.5px] text-muted-foreground">{j.actor || '—'}</td>
              <td className="py-1.5 pr-3">
                <StatusPill tone={j.tone}>{j.dry ? 'dry run' : j.status}</StatusPill>
              </td>
              <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{j.items || '—'}</td>
              <td className="py-1.5 pr-3 text-muted-foreground">{j.requestedByName}</td>
              <td className={cn('max-w-[280px] truncate py-1.5 pr-3', j.status === 'failed' ? 'text-status-error' : 'text-muted-foreground')} title={j.error}>
                {j.error || '—'}
              </td>
              <td className="py-1.5 tabular-nums text-muted-foreground">{ago(j.updatedMs, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

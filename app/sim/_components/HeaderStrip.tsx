'use client';

import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill';
import type { HeaderStats } from '../_lib/selectors';
import { pct, usd } from '../_lib/format';
import { Spark } from './charts';

const ROUND_TONE: Record<string, StatusPillTone> = {
  running: 'active',
  done: 'connected',
  failed: 'failed',
};

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex min-w-[120px] flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className="font-mono text-xl font-semibold tabular-nums text-foreground">{value}</span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

// Round, sim day, Jev calls, cost and cache hit rate for the selected run, recomputed as rows arrive.
export function HeaderStrip({ stats, connected }: { stats: HeaderStats; connected: boolean }) {
  return (
    <div className="frost-card flex flex-wrap items-end gap-x-10 gap-y-4 rounded-xl px-6 py-4">
      <Stat
        label="Round"
        value={stats.round == null ? '–' : stats.round === 0 ? 'warm-up' : `${stats.round} / ${stats.roundsPlanned}`}
        sub={
          stats.roundStatus ? (
            <StatusPill tone={ROUND_TONE[stats.roundStatus] ?? 'queued'} className="mt-0.5">
              {stats.roundStatus}
            </StatusPill>
          ) : (
            stats.roundsPlanned > 0 ? `warm-up + ${stats.roundsPlanned} rounds planned` : 'no run yet'
          )
        }
      />
      <Stat label="Sim day" value={stats.simDay == null ? '–' : `${stats.simDay} / ${stats.ticksPerRound}`} sub="days per round" />
      <Stat
        label="Jev calls"
        value={stats.calls.toLocaleString()}
        sub={stats.callsPerDay.length > 1 ? <Spark data={stats.callsPerDay} color="var(--chart-1)" w={110} h={18} min={0} /> : 'per sim day'}
      />
      <Stat label="Cost" value={usd(stats.costUsd, 4)} sub={stats.costIsEstimate ? 'estimate while a round runs' : 'from round summaries'} />
      <Stat label="Cache hit rate" value={pct(stats.cacheHitRate, 0)} sub="state seen before" />
      <div className="ml-auto self-center">
        <StatusPill tone={connected ? 'connected' : 'queued'}>{connected ? 'live' : 'connecting'}</StatusPill>
      </div>
    </div>
  );
}

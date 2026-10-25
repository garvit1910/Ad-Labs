'use client';

import { cn } from '@/lib/utils';
import type { TickerRow } from '../_lib/selectors';
import { pct } from '../_lib/format';

const OUTCOME: Record<string, { label: string; className: string }> = {
  buy: { label: 'bought', className: 'text-status-success' },
  stay: { label: 'stayed', className: 'text-foreground' },
  bounce: { label: 'bounced', className: 'text-status-warning' },
  lost_to_competitor: { label: 'tapped a rival', className: 'text-status-error' },
  scroll: { label: 'scrolled past', className: 'text-muted-foreground' },
};

// A probability bar with the dice marked on it: the shopper acts when the dice land left of the
// bar's end (draw < p).
function DiceBar({ p, draw, color }: { p: number | null; draw: number | null; color: string }) {
  if (p == null) return <span className="inline-block h-1.5 w-20" />;
  return (
    <span className="relative inline-block h-1.5 w-20 rounded-full bg-secondary" title={`p ${pct(p)}${draw != null ? ` · dice ${draw.toFixed(3)}` : ''}`}>
      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(1.5, p * 100)}%`, background: color }} />
      {draw != null && <span className="absolute -top-0.5 h-2.5 w-px bg-foreground" style={{ left: `${draw * 100}%` }} />}
    </span>
  );
}

// The latest impressions, newest first: who saw which ad, the calibrated chances the engine rolled
// against and where the dice fell. Click a row to open that shopper in the inspector.
export function DecisionTicker({
  rows,
  ticksPerRound,
  selected,
  pinnedId = null,
  onSelect,
}: {
  rows: TickerRow[];
  ticksPerRound: number;
  selected: string | null;
  pinnedId?: string | null;
  onSelect: (shopperId: string) => void;
}) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No decisions yet.</p>;
  return (
    <div className="max-h-[420px] overflow-y-auto pr-1">
      <ul className="flex flex-col">
        {rows.map((r) => {
          const outcome = r.pageAction && r.pageAction !== 'not_tapped' ? r.pageAction : r.action === 'tap' ? 'tap' : r.action;
          const o = OUTCOME[outcome] ?? { label: outcome.replaceAll('_', ' '), className: 'text-muted-foreground' };
          return (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => onSelect(r.shopperId)}
                className={cn(
                  'grid w-full grid-cols-[52px_1fr_auto] items-center gap-x-3 gap-y-1 border-t border-border/60 px-1 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40',
                  selected === r.shopperId && 'bg-secondary/60',
                )}
              >
                <span className="font-mono text-[10px] text-muted-foreground">
                  R{r.round}·D{(r.tick % ticksPerRound) + 1}
                </span>
                <span className="min-w-0 truncate">
                  <b className="font-medium text-foreground">{r.shopperName}</b>
                  {r.shopperId === pinnedId && <span className="ml-1 rounded bg-brand/15 px-1 text-[9.5px] font-medium text-brand">pinned</span>}
                  <span className="text-muted-foreground"> saw </span>
                  <span className="text-foreground">{r.headline}</span>
                </span>
                <span className={cn('text-right font-medium', o.className)}>{o.label}</span>
                <span />
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    tap {pct(r.pTap)} <DiceBar p={r.pTap} draw={r.draw} color="var(--chart-1)" />
                  </span>
                  <span>stay {pct(r.pStay)}</span>
                  <span>buy | stay {pct(r.pBuy)}</span>
                </span>
                <span />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

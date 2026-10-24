'use client';

import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { LeaderRow, SegmentBoard } from '../_lib/selectors';
import { pct, usd } from '../_lib/format';
import { RangeBar } from './charts';

// One tab per segment: every recipe ranked by expected reward, the control row pinned in place,
// P(best) from the bandit's posterior and cost per order with its ±2 sd range on a shared axis.
export function Leaderboard({ boards, colors }: { boards: SegmentBoard[]; colors: Map<string, string> }) {
  if (boards.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No arm stats yet: they land after the first sim day.</p>;
  }
  return (
    <Tabs defaultValue={boards[0]!.segmentId} className="gap-3">
      <TabsList className="h-auto flex-wrap">
        {boards.map((b) => (
          <TabsTrigger key={b.segmentId} value={b.segmentId} className="text-xs">
            {b.name}
          </TabsTrigger>
        ))}
      </TabsList>
      {boards.map((b) => (
        <TabsContent key={b.segmentId} value={b.segmentId}>
          <Board board={b} colors={colors} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function Board({ board, colors }: { board: SegmentBoard; colors: Map<string, string> }) {
  // A shared axis per segment, capped at 4× the control's cost so one weak arm can't squash the rest.
  const finite = board.rows.flatMap((r) => [r.cpo, r.cpoHigh]).filter((v): v is number => v != null);
  const cap = board.control?.cpo != null ? board.control.cpo * 4 : Infinity;
  const max = Math.min(cap, Math.max(1, ...finite));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <th className="py-1.5 pr-2 font-medium">#</th>
            <th className="py-1.5 pr-4 font-medium">Recipe</th>
            <th className="py-1.5 pr-4 text-right font-medium">Impressions</th>
            <th className="py-1.5 pr-4 font-medium">P(best)</th>
            <th className="py-1.5 pr-4 text-right font-medium">Cost / order</th>
            <th className="py-1.5 font-medium">range (±2 sd)</th>
          </tr>
        </thead>
        <tbody>
          {board.rows.map((r, i) => (
            <Row key={r.armId} rank={i + 1} row={r} color={colors.get(r.armId) ?? 'var(--muted-foreground)'} max={max} top={board.topRecipe?.armId === r.armId} />
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        Round {board.round} · {board.topRecipe ? <>generation candidate: <b className="text-foreground">{board.topRecipe.label}</b> (highest P(best) among recipes)</> : 'no recipe stats yet'}
        {board.control?.cpo != null && <> · control {usd(board.control.cpo)} per order</>}
      </p>
    </div>
  );
}

function Row({ rank, row, color, max, top }: { rank: number; row: LeaderRow; color: string; max: number; top: boolean }) {
  return (
    <tr className={cn('border-t border-border/60', row.isControl && 'bg-secondary/40')}>
      <td className="py-1.5 pr-2 font-mono text-xs text-muted-foreground">{rank}</td>
      <td className="py-1.5 pr-4">
        <span className="inline-flex items-center gap-2">
          <i className="size-[9px] flex-none rounded-[2px]" style={{ background: color }} />
          <span className={cn(row.isControl ? 'text-muted-foreground' : 'text-foreground')}>{row.label}</span>
          {row.isControl && <Badge variant="outline" className="text-[10px]">control</Badge>}
          {top && <Badge variant="secondary" className="text-[10px]">generation candidate</Badge>}
        </span>
      </td>
      <td className="py-1.5 pr-4 text-right font-mono tabular-nums">{row.impressions.toLocaleString()}</td>
      <td className="py-1.5 pr-4">
        <span className="inline-flex items-center gap-2 font-mono tabular-nums">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-secondary">
            <span className="block h-full rounded-full" style={{ width: `${Math.max(2, row.pBest * 100)}%`, background: color }} />
          </span>
          {pct(row.pBest, 0)}
        </span>
      </td>
      <td className="py-1.5 pr-4 text-right font-mono tabular-nums">{usd(row.cpo)}</td>
      <td className="py-1.5">
        <RangeBar low={row.cpoLow} mid={row.cpo} high={row.cpoHigh != null && row.cpoHigh <= max ? row.cpoHigh : null} max={max} color={color} />
      </td>
    </tr>
  );
}

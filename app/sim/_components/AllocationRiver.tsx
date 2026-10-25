'use client';

// ALLOCATION RIVER — impressions per recipe per sim day, stacked and centred. Adapted from ShopSim
// (github.com/garvit1910/shopsim, web/components/AllocationRiver.tsx): the same centred stack,
// midpoint-quadratic smoothing, guides and hover legend. Changes for Ad Lab:
//   - bands are recipes (bandit arms), counted from the feed decision rows; the control keeps a
//     fixed neutral colour;
//   - the reveal edge is the latest sim day written to SpacetimeDB (no market clock), so the river
//     grows as the worker writes each day;
//   - ShopSim's CSS (--grid/--muted/--ink/--mono, .river/.rchip/.rnote) → Adcero tokens.

import { useRef, useState } from 'react';
import type { RiverSeries } from '../_lib/selectors';

const W = 1000;
const PAD = { t: 14, r: 14, b: 26, l: 46 };

/** Midpoint-quadratic smoothing — flowing bands without overshoot. */
function smooth(pts: [number, number][]): string {
  if (!pts.length) return '';
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('');
  let d = `M${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    d += `Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const last = pts[pts.length - 1]!;
  d += `L${last[0]} ${last[1]}`;
  return d;
}

export default function AllocationRiver({
  series,
  ticks,
  ticksPerRound,
  h = 300,
}: {
  series: RiverSeries[];
  /** sim days the run will have (warm-up + planned rounds) × days per round */
  ticks: number;
  ticksPerRound: number;
  h?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const iw = W - PAD.l - PAD.r;
  const ih = h - PAD.t - PAD.b;
  const have = Math.max(0, ...series.map((s) => s.perDay.length));
  const dayTotals = Array.from({ length: have }, (_, i) => series.reduce((sum, s) => sum + (s.perDay[i] ?? 0), 0));
  const peak = Math.max(1, ...dayTotals);
  const span = Math.max(ticks, have, 2);
  const edge = Math.max(0, have - 1);
  const X = (day: number) => PAD.l + iw * (day / Math.max(1, span - 1));
  const Yc = PAD.t + ih / 2;
  const scale = (v: number) => (v / peak) * ih;

  const days: number[] = Array.from({ length: have }, (_, i) => i);
  const bands = series.map(() => ({ top: [] as [number, number][], bot: [] as [number, number][] }));
  for (const day of days) {
    const total = series.reduce((sum, s) => sum + (s.perDay[day] ?? 0), 0);
    let cum = -total / 2;
    series.forEach((s, si) => {
      const v = s.perDay[day] ?? 0;
      bands[si]!.bot.push([X(day), Yc + scale(cum)]);
      cum += v;
      bands[si]!.top.push([X(day), Yc + scale(cum)]);
    });
  }

  const hoverDay = hover != null ? Math.max(0, Math.min(edge, hover)) : null;
  const shownDay = hoverDay ?? edge;
  const shownTotal = dayTotals[shownDay] ?? 0;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const day = Math.round(((px - PAD.l) / iw) * Math.max(1, span - 1));
    setHover(day >= 0 && day <= edge ? day : null);
  };

  // A divider at every round boundary; round 0 is the warm-up.
  const rounds = Array.from({ length: Math.ceil(span / ticksPerRound) }, (_, r) => r);

  if (have === 0) {
    return <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">No impressions yet: the river fills as the worker writes each sim day.</div>;
  }

  return (
    <div className="px-1.5 pb-2.5 pt-1">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${h}`}
        role="img"
        preserveAspectRatio="xMidYMid meet"
        aria-label={`Impressions per recipe per sim day across ${have} of ${span} days`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className="block h-auto w-full cursor-crosshair"
      >
        {[0.5, 0, -0.5].map((f, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={Yc + f * ih} y2={Yc + f * ih} stroke="var(--border)" strokeDasharray={i === 1 ? undefined : '2 3'} />
            <text x={PAD.l - 6} y={Yc + f * ih + 3.5} textAnchor="end" fontSize={10} fill="var(--muted-foreground)" fontFamily="var(--font-mono)">
              {i === 1 ? '0' : Math.round(peak / 2).toLocaleString()}
            </text>
          </g>
        ))}
        {rounds.map((r) => (
          <g key={r}>
            {r > 0 && <line x1={X(r * ticksPerRound - 0.5)} x2={X(r * ticksPerRound - 0.5)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--border)" />}
            <text x={X(r * ticksPerRound + (ticksPerRound - 1) / 2)} y={h - 7} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)" fontFamily="var(--font-mono)">
              {r === 0 ? 'warm-up' : `round ${r}`}
            </text>
          </g>
        ))}
        {bands.map((b, si) => (
          <path key={series[si]!.id} d={`${smooth(b.top)}L${smooth([...b.bot].reverse()).slice(1)}Z`} fill={series[si]!.color} opacity={0.86}>
            <title>{series[si]!.name}</title>
          </path>
        ))}
        {/* the live edge: the latest sim day written */}
        <line x1={X(edge)} x2={X(edge)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--foreground)" strokeWidth={1} opacity={0.35} />
        {hoverDay != null && <line x1={X(hoverDay)} x2={X(hoverDay)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--foreground)" strokeWidth={1} opacity={0.55} />}
      </svg>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px]">
        {series.map((s) => {
          const v = s.perDay[shownDay] ?? 0;
          const share = shownTotal > 0 ? (v / shownTotal) * 100 : 0;
          return (
            <span key={s.id} className="inline-flex items-center gap-1.5 text-muted-foreground" title={`${s.name} · ${v.toLocaleString()} impressions`}>
              <i className="size-[9px] flex-none rounded-[2px]" style={{ background: s.color }} />
              <b className="font-semibold text-foreground">{s.name}</b>
              <em className="not-italic tabular-nums">{share.toFixed(0)}%</em>
            </span>
          );
        })}
        <span className="ml-auto text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">
          {hoverDay != null
            ? `day ${(hoverDay % ticksPerRound) + 1} of round ${Math.floor(hoverDay / ticksPerRound)} · ${shownTotal.toLocaleString()} impressions`
            : 'the bandit moves impressions to the winners each round'}
        </span>
      </div>
    </div>
  );
}

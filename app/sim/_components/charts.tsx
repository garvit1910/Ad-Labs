'use client';

// Hand-rolled SVG chart primitives, adapted from ShopSim (github.com/garvit1910/shopsim,
// web/components/charts.tsx): thin marks, recessive grid, last-point emphasis, direct labels.
// ShopSim's CSS variables map to Adcero's tokens: --grid → --border, --muted → --muted-foreground,
// --ink → --foreground, --mono → --font-mono. RangeBar is new, in the same style.

const GRID = 'var(--border)';
const MUTED = 'var(--muted-foreground)';
const MONO = 'var(--font-mono)';

export function Spark({
  data,
  upto,
  color,
  w = 96,
  h = 20,
  min,
}: {
  data: (number | null)[];
  upto?: number;
  color: string;
  w?: number;
  h?: number;
  min?: number;
}) {
  const last = upto ?? data.length - 1;
  const vis = data.slice(0, last + 1).filter((v): v is number => v != null);
  if (!vis.length) return <svg width={w} height={h} aria-hidden />;
  const lo = min ?? Math.min(...vis);
  let hi = Math.max(...vis);
  if (hi - lo < 1e-9) hi = lo + 1;
  const X = (i: number) => 2 + (w - 4) * (i / Math.max(1, data.length - 1));
  const Y = (v: number) => 2 + (h - 4) * (1 - (v - lo) / (hi - lo));
  let d = '';
  let end: [number, number] | null = null;
  data.forEach((v, i) => {
    if (i > last || v == null) return;
    d += `${d ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
    end = [X(i), Y(v)];
  });
  const endPt = end as [number, number] | null;
  return (
    <svg width={w} height={h} aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      {endPt && <circle cx={endPt[0]} cy={endPt[1]} r={2.4} fill={color} />}
    </svg>
  );
}

export interface LineSeries {
  data: (number | null)[];
  color: string;
  label?: string;
  fill?: boolean;
  dash?: string;
}

export function LineChart({
  series,
  upto,
  ticks,
  h = 110,
  min,
  max,
  yFmt,
  aria,
}: {
  series: LineSeries[];
  upto: number;
  ticks: number;
  h?: number;
  min?: number;
  max?: number;
  yFmt?: (v: number) => string;
  aria?: string;
}) {
  const w = 340;
  const p = { t: 8, r: 10, b: 16, l: 38 };
  const iw = w - p.l - p.r;
  const ih = h - p.t - p.b;
  const vis = series.flatMap((s) => s.data.slice(0, upto + 1)).filter((v): v is number => v != null);
  let lo = min ?? (vis.length ? Math.min(...vis) : 0);
  let hi = max ?? (vis.length ? Math.max(...vis) : 1);
  if (hi - lo < 1e-9) hi = lo + 1;
  if (min == null) lo -= (hi - lo) * 0.08;
  if (max == null) hi += (hi - lo) * 0.08;
  const X = (i: number) => p.l + iw * (i / Math.max(1, ticks - 1));
  const Y = (v: number) => p.t + ih * (1 - (v - lo) / (hi - lo));
  const fmt = yFmt ?? ((v: number) => v.toFixed(2));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={aria ?? 'chart'}>
      {[0, 1, 2].map((i) => {
        const y = p.t + (ih * i) / 2;
        const v = hi - ((hi - lo) * i) / 2;
        return (
          <g key={i}>
            <line x1={p.l} x2={w - p.r} y1={y} y2={y} stroke={GRID} />
            <text x={p.l - 5} y={y + 3.5} textAnchor="end" fontSize={9} fill={MUTED} fontFamily={MONO}>
              {fmt(v)}
            </text>
          </g>
        );
      })}
      {series.map((s, si) => {
        let d = '';
        let first: [number, number] | null = null;
        let lastPt: [number, number] | null = null;
        s.data.forEach((v, i) => {
          if (i > upto || v == null) return;
          d += `${d ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
          if (!first) first = [X(i), Y(v)];
          lastPt = [X(i), Y(v)];
        });
        if (!first || !lastPt) return null;
        const a = first as [number, number];
        const b = lastPt as [number, number];
        return (
          <g key={si}>
            {s.fill && <path d={`${d} L ${b[0]} ${p.t + ih} L ${a[0]} ${p.t + ih} Z`} fill={s.color} opacity={0.08} />}
            <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dash} />
            <circle cx={b[0]} cy={b[1]} r={3} fill={s.color} />
            {s.label && (
              <text x={Math.min(b[0] + 5, w - 4)} y={b[1] - 5} fontSize={9.5} fontWeight={700} fill={s.color} fontFamily={MONO} textAnchor={b[0] > w - 56 ? 'end' : 'start'}>
                {s.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// A cost-per-order range on a shared axis: the bar spans the ±2 sd range, the dot is the estimate.
// A missing high end (the range reaches zero reward) runs to the axis edge, dashed.
export function RangeBar({
  low,
  mid,
  high,
  max,
  color,
  w = 160,
  h = 12,
}: {
  low: number | null;
  mid: number | null;
  high: number | null;
  max: number;
  color: string;
  w?: number;
  h?: number;
}) {
  const X = (v: number) => 2 + (w - 4) * Math.min(1, Math.max(0, v / Math.max(max, 1e-9)));
  const y = h / 2;
  return (
    <svg width={w} height={h} aria-hidden>
      <line x1={2} x2={w - 2} y1={y} y2={y} stroke={GRID} />
      {low != null && (
        <line x1={X(low)} x2={high != null ? X(high) : w - 2} y1={y} y2={y} stroke={color} strokeWidth={3} strokeLinecap="round" strokeDasharray={high == null ? '3 3' : undefined} opacity={0.55} />
      )}
      {mid != null && <circle cx={X(mid)} cy={y} r={3.5} fill={color} />}
    </svg>
  );
}

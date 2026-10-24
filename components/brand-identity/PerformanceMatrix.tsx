'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { layoutMatrix, type Rect } from './matrix-layout';
import { useTacticExample } from './tactic-example-context';
import {
  QUADRANTS,
  SIGNAL_ACCENT,
  scoreLabel,
  signalQuadrantColor,
  type MatrixColorScheme,
  type MatrixModel,
  type QuadrantKey,
} from './winners-matrix';

/** alpha-suffixed hex helpers (color is always a 6-digit hex). */
const tint = (hex: string, alpha: string) => `${hex}${alpha}`;

/**
 * Measures each label's true rendered width (px) with a shared canvas so the
 * layout can reserve an exact-fit box - labels then never clip. `font` must
 * match the label span's computed font (`500 16px <family>` for the
 * text-base/font-medium span). Returns integer widths with a 1px cushion to
 * absorb sub-pixel rounding.
 */
let sharedMeasureCanvas: HTMLCanvasElement | null = null;
function measureLabelWidths(labels: string[], font: string): Map<string, number> {
  const widths = new Map<string, number>();
  if (typeof document === 'undefined') return widths;
  sharedMeasureCanvas ??= document.createElement('canvas');
  const ctx = sharedMeasureCanvas.getContext('2d');
  if (!ctx) return widths;
  ctx.font = font;
  for (const label of labels) {
    widths.set(label, Math.ceil(ctx.measureText(label).width) + 1);
  }
  return widths;
}

/** Reserved footprint of a quadrant title box, px - kept clear of dot labels. */
const TITLE_W = 250;
const TITLE_H = 48;

function QuadrantZone({
  quadrant,
  title,
  subtitle,
  style,
  align,
  vAlign,
  colorScheme,
}: {
  quadrant: QuadrantKey;
  title: string;
  subtitle: string;
  style: React.CSSProperties;
  align: 'left' | 'right';
  vAlign: 'top' | 'bottom';
  colorScheme: MatrixColorScheme;
}) {
  const q = QUADRANTS[quadrant];
  const signal = colorScheme === 'signal';
  // Both schemes keep the per-quadrant colour + faint tint so the four zones stay
  // readable at a glance; Signal only swaps the winning quadrant to brand magenta
  // so it still matches the accent its dots and ranking bars carry.
  const color = signal && quadrant === 'power' ? SIGNAL_ACCENT : q.color;
  const backgroundColor = tint(color, '0d');
  return (
    <div className="absolute" style={{ ...style, backgroundColor }}>
      <div
        className={cn(
          'absolute px-3 text-[15px] font-semibold leading-tight',
          align === 'left' ? 'left-2 text-left' : 'right-2 text-right',
          vAlign === 'top' ? 'top-2' : 'bottom-2'
        )}
        style={{ color }}
      >
        {title}
        <div className="text-[13px] font-normal text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  );
}

export function PerformanceMatrix({
  model,
  colorScheme = 'category',
}: {
  model: MatrixModel;
  colorScheme?: MatrixColorScheme;
}) {
  const { tactics, display } = model;
  const t = useTranslations('BrandIdentity.performanceMatrix');
  // When a provider is mounted, a label whose tactic has a loaded top ad
  // becomes a button that opens it; otherwise labels stay plain text.
  const tacticExample = useTacticExample();
  // The piecewise scale pins both midlines at 50% by construction.
  const xMidPct = 50;
  const yMidPct = 50;
  const topH = 100 - yMidPct; // high-win (top) region height %

  // Tick labels are preformatted per mode (winners: score / ×; provisional: days / counts).
  const { xTickLabels, yTickLabels, quadrantTitles } = display;

  // Measure the plot area so the no-overlap layout runs in real pixel space and
  // re-flows responsively. Markers render once we have a width (avoids SSR jump).
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tacticById = useMemo(
    () => new Map(tactics.map((t) => [`${t.dimension}:${t.label}`, t])),
    [tactics]
  );

  // Real per-label pixel widths (keyed by tactic id) so the layout reserves an
  // exact-fit box and the rendered labels never clip. Re-measured once the plot
  // mounts (so the label font-family resolves) and whenever the tactics change. `size` is a dep only
  // to re-run after the first client paint populates plotRef.
  const labelWidths = useMemo(() => {
    const family = plotRef.current
      ? getComputedStyle(plotRef.current).fontFamily
      : 'sans-serif';
    const names = measureLabelWidths(
      tactics.map((t) => t.displayLabel),
      `500 16px ${family}`
    );
    const widths = new Map<string, number>();
    for (const t of tactics) {
      const name = names.get(t.displayLabel);
      if (name == null) continue;
      widths.set(`${t.dimension}:${t.label}`, name);
    }
    return widths;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tactics, size]);

  const layout = useMemo(() => {
    const { width, height } = size;
    // Reserve the four outer corners (where the quadrant titles live) so labels
    // never collide with them.
    const blockedRects: Rect[] =
      width > 0 && height > 0
        ? [
            { x: 2, y: 2, w: TITLE_W, h: TITLE_H }, // common (top-left)
            { x: width - 2 - TITLE_W, y: 2, w: TITLE_W, h: TITLE_H }, // power (top-right)
            { x: 2, y: height - 2 - TITLE_H, w: TITLE_W, h: TITLE_H }, // under (bottom-left)
            {
              x: width - 2 - TITLE_W,
              y: height - 2 - TITLE_H,
              w: TITLE_W,
              h: TITLE_H,
            }, // gems (bottom-right)
          ]
        : [];
    return layoutMatrix({
      width,
      height,
      blockedRects,
      items: tactics.map((t) => ({
        id: `${t.dimension}:${t.label}`,
        xPct: t.x,
        yPct: t.y,
        label: t.displayLabel,
        quadrant: t.quadrant,
        textWidthPx: labelWidths.get(`${t.dimension}:${t.label}`),
      })),
    });
  }, [tactics, size, labelWidths]);

  return (
    <Card variant="plain" className="flex h-full flex-col border-neutral-200/80 p-5 shadow-none">
      <div className="mb-1 flex items-center gap-1.5">
        <h3 className="text-base font-semibold">{t('title')}</h3>
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('help')}
                className="text-muted-foreground hover:text-foreground"
              >
                <HelpCircle className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">{display.tooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">{display.caption}</p>

      {/* plot fills the card height; y caption | y ticks | plot share the plot row */}
      <div className="flex flex-1 flex-col">
        <div className="flex flex-1">
          <div className="flex w-5 items-center justify-center">
            <span className="-rotate-90 whitespace-nowrap text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {display.yAxisLabel}
            </span>
          </div>

          {/* y tick labels - same height as the plot, so they stay aligned */}
          <div className="flex w-11 flex-col justify-between py-1 pr-1 text-right text-xs tabular-nums text-muted-foreground">
            {yTickLabels.map((t, i) => (
              <span key={i}>{t}</span>
            ))}
          </div>

          <div
            ref={plotRef}
            className="relative min-h-[420px] flex-1 overflow-visible rounded-md border border-neutral-200/70"
          >
            {/* Quadrant zones - titles pinned to the four outer corners */}
            <QuadrantZone
              quadrant="common"
              title={quadrantTitles.common.title}
              subtitle={quadrantTitles.common.subtitle}
              align="left"
              vAlign="top"
              colorScheme={colorScheme}
              style={{ left: 0, top: 0, width: `${xMidPct}%`, height: `${topH}%` }}
            />
            <QuadrantZone
              quadrant="power"
              title={quadrantTitles.power.title}
              subtitle={quadrantTitles.power.subtitle}
              align="right"
              vAlign="top"
              colorScheme={colorScheme}
              style={{ left: `${xMidPct}%`, top: 0, right: 0, height: `${topH}%` }}
            />
            <QuadrantZone
              quadrant="under"
              title={quadrantTitles.under.title}
              subtitle={quadrantTitles.under.subtitle}
              align="left"
              vAlign="bottom"
              colorScheme={colorScheme}
              style={{ left: 0, bottom: 0, width: `${xMidPct}%`, height: `${yMidPct}%` }}
            />
            <QuadrantZone
              quadrant="gems"
              title={quadrantTitles.gems.title}
              subtitle={quadrantTitles.gems.subtitle}
              align="right"
              vAlign="bottom"
              colorScheme={colorScheme}
              style={{ left: `${xMidPct}%`, bottom: 0, right: 0, height: `${yMidPct}%` }}
            />

            {/* Dividers */}
            <div
              className="absolute top-0 bottom-0 border-l border-dashed border-neutral-300"
              style={{ left: `${xMidPct}%` }}
            />
            <div
              className="absolute left-0 right-0 border-t border-dashed border-neutral-300"
              style={{ top: `${topH}%` }}
            />

            {size.width > 0 && (
              <>
                {/* Labels */}
                {layout.items.map((it) => {
                  const tactic = tacticById.get(it.id);
                  if (!tactic) return null;
                  const examples = tacticExample
                    ? tactic.exampleAdIds
                        .map((id) => tacticExample.adById.get(id))
                        .filter((ad): ad is NonNullable<typeof ad> => ad != null)
                    : [];
                  return (
                    <div
                      key={`label:${it.id}`}
                      className="absolute z-20"
                      style={{
                        left: it.label.x,
                        top: it.label.y,
                        width: it.label.w,
                        height: it.label.h,
                      }}
                    >
                      {examples.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => tacticExample?.openAds(examples)}
                          title={t('showAds', { count: examples.length, label: tactic.displayLabel })}
                          className="block w-full cursor-pointer whitespace-nowrap border-0 bg-transparent px-1.5 py-0 text-left text-base font-medium leading-[22px] text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                        >
                          {tactic.displayLabel}
                        </button>
                      ) : (
                        <span
                          className="block w-full whitespace-nowrap px-1.5 text-base font-medium leading-[22px] text-foreground"
                        >
                          {tactic.displayLabel}
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* Dots */}
                {layout.items.map((it) => {
                  const tactic = tacticById.get(it.id);
                  if (!tactic) return null;
                  const signal = colorScheme === 'signal';
                  const isWinner = tactic.quadrant === 'power';
                  const dotColor = signal
                    ? signalQuadrantColor(tactic.quadrant)
                    : tactic.color;
                  // Signal drives the ring (and the winner's magenta halo) via
                  // inline box-shadow so the winner pops and the rest recede;
                  // category keeps the flat tailwind ring.
                  const dotSize = signal && isWinner ? 11 : 9;
                  const dotBoxShadow = signal
                    ? isWinner
                      ? `0 0 0 2px #fff, 0 0 0 6px ${SIGNAL_ACCENT}33`
                      : '0 0 0 2px #fff'
                    : undefined;
                  return (
                    <span
                      key={`dot:${it.id}`}
                      className={cn(
                        'absolute z-30 rounded-full',
                        !signal && 'shadow-sm ring-2 ring-white'
                      )}
                      style={{
                        left: it.dot.x,
                        top: it.dot.y,
                        width: dotSize,
                        height: dotSize,
                        backgroundColor: dotColor,
                        boxShadow: dotBoxShadow,
                        transform: 'translate(-50%, -50%)',
                      }}
                      title={
                        model.mode === 'winners'
                          ? t('dotWinners', {
                              label: tactic.displayLabel,
                              volume: tactic.volume,
                              score: scoreLabel(tactic.medianWinScore),
                              winners: tactic.winnerCount,
                            })
                          : t('dotProvisional', {
                              label: tactic.displayLabel,
                              volume: tactic.volume,
                              days: Math.round(tactic.medianLongevity),
                            })
                      }
                    />
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* x tick labels - pl-16 (= w-5 + w-11) aligns them under the plot */}
        <div className="mt-1 flex justify-between pl-16 text-xs tabular-nums text-muted-foreground">
          {xTickLabels.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
        <p className="mt-1 pl-16 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {display.xAxisLabel}
        </p>
      </div>
    </Card>
  );
}

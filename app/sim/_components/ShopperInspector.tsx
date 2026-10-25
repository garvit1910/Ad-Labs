'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { BrandRow, CreativeRow, SegmentRow, Shopper } from '@/lib/spacetime/bindings/types';
import { type ShopperStep, memoryLines, shopperAndMemory, stateBlocks, withoutLine } from '../_lib/selectors';
import {
  type Offsets,
  PAGE_QUESTIONS,
  believesQuestion,
  calibrate,
  pct,
  renderAd,
  tapQuestion,
  usd,
  words,
} from '../_lib/format';
import { type Asked, ask } from '../_lib/whatif';
import type { PinnedCapture } from '../_lib/pinned';
import { PinnedStory } from './PinnedStory';

// One shopper, as Jev saw them. Layout ideas from ShopSim's Inspector (header chips, probability
// bars, the "need removed → P(buy) ×N" counterfactual line); the data is Ad Lab's: the exact page
// state from shopper.state_text, the questions, raw and calibrated chances, the dice, and every
// impression across rounds rebuilt from the decision rows.

type WhatIf = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; with: Pair; without: Pair };
type Pair = { feed: Asked | null; page: Asked };

export function ShopperInspector({
  shopper,
  steps,
  creatives,
  brands,
  segments,
  offsets,
  ticksPerRound,
  pinned = null,
}: {
  shopper: Shopper | undefined;
  steps: ShopperStep[];
  creatives: readonly CreativeRow[];
  brands: readonly BrandRow[];
  segments: readonly SegmentRow[];
  offsets: Offsets | undefined;
  ticksPerRound: number;
  pinned?: PinnedCapture | null;
}) {
  const creative = useMemo(() => new Map(creatives.map((c) => [c.creativeId, c])), [creatives]);
  const brandName = useMemo(() => new Map(brands.map((b) => [b.brandId, b.name])), [brands]);
  const [removed, setRemoved] = useState<string | null>(null);
  const [whatIf, setWhatIf] = useState<WhatIf>({ status: 'idle' });
  const shopperId = shopper?.shopperId;
  useEffect(() => {
    setRemoved(null);
    setWhatIf({ status: 'idle' });
  }, [shopperId]);

  const latest = steps[steps.length - 1];
  const stateText = shopper?.stateText ?? '';
  const lines = useMemo(() => memoryLines(stateText), [stateText]);

  // The feed the latest impression showed, rebuilt in the sim's words (sim/src/render.ts).
  const feed = useMemo(() => {
    if (!latest || latest.order.length === 0) return null;
    const ads = latest.order.map((id) => creative.get(id));
    if (ads.some((c) => !c)) return null;
    const name = (c: CreativeRow) => brandName.get(c.brandId) ?? c.brandId;
    const keys = ['A', 'B', 'C'];
    const ours = creative.get(latest.creativeId)!;
    const questions: Record<string, object> = Object.fromEntries(ads.map((c, i) => [`tap_${keys[i]}`, tapQuestion(c!, name(c!))]));
    questions.believes = believesQuestion(ours, name(ours));
    const ourKey = `tap_${keys[latest.order.indexOf(latest.creativeId)]}`;
    const rightNow = ['RIGHT NOW', 'Scrolling Instagram on their phone. Three sponsored posts appear one after another:', ...ads.map((c) => `- ${renderAd(c!, name(c!))}`)].join('\n');
    return { questions, ourKey, state: (without?: string) => `${shopperAndMemory(stateText, without)}\n\n${rightNow}` };
  }, [latest, creative, brandName, stateText]);

  const runWhatIf = async (line: string) => {
    setRemoved(line);
    setWhatIf({ status: 'loading' });
    try {
      const [feedWith, feedWithout, pageWith, pageWithout] = await Promise.all([
        feed ? ask(feed.state(), feed.questions) : null,
        feed ? ask(feed.state(line), feed.questions) : null,
        ask(stateText, PAGE_QUESTIONS),
        ask(withoutLine(stateText, line), PAGE_QUESTIONS),
      ]);
      setWhatIf({ status: 'done', with: { feed: feedWith, page: pageWith! }, without: { feed: feedWithout, page: pageWithout! } });
    } catch (err) {
      setWhatIf({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (!shopper) return <p className="py-6 text-center text-sm text-muted-foreground">Pick a shopper from the ticker.</p>;

  const segment = segments.find((s) => s.segmentId === shopper.segmentId);
  const buys = steps.filter((s) => s.pageAction === 'buy').length;
  const blocks = stateBlocks(stateText);
  const removable = new Set(lines.map((l) => l.text));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <b className="text-base font-semibold text-foreground">{shopper.displayName}</b>
        {pinned && <Badge className="text-[10px]">pinned</Badge>}
        <Badge variant="outline">{segment?.name ?? shopper.segmentId}</Badge>
        <Badge variant={shopper.inMarket ? 'secondary' : 'outline'}>{shopper.inMarket ? 'in market' : 'not shopping'}</Badge>
        <span className="font-mono text-muted-foreground">budget left {usd(shopper.budgetLeftUsd)}</span>
        <span className="font-mono text-muted-foreground">· {steps.length} impressions · {buys} {buys === 1 ? 'buy' : 'buys'}</span>
        <span className="font-mono text-muted-foreground/70">{shopper.shopperId}</span>
      </div>

      {pinned && <PinnedStory capture={pinned} ticksPerRound={ticksPerRound} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-2">
          <h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            State Jev read on the latest page call · click a highlighted line to re-ask without it
          </h3>
          <div className="rounded-lg border border-border bg-background/60 p-3 font-mono text-[11.5px] leading-relaxed">
            {[['SHOPPER', blocks.shopper], ['MEMORY', blocks.memory]].map(([title, body]) => (
              <div key={title as string} className="mb-2">
                <div className="font-semibold text-foreground">{title as string}</div>
                {(body as string[]).map((l) =>
                  removable.has(l) ? (
                    <button
                      key={l}
                      type="button"
                      onClick={() => (removed === l ? (setRemoved(null), setWhatIf({ status: 'idle' })) : runWhatIf(l))}
                      className={cn(
                        'block w-full rounded px-1 -mx-1 text-left transition-colors',
                        removed === l ? 'bg-status-warning-soft text-status-warning line-through' : 'text-foreground hover:bg-secondary/60 underline decoration-dotted decoration-muted-foreground/60 underline-offset-2',
                      )}
                    >
                      {l}
                    </button>
                  ) : (
                    <div key={l} className="text-muted-foreground">{l}</div>
                  ),
                )}
              </div>
            ))}
            {blocks.rest.map((b) => (
              <div key={b} className="mb-2 whitespace-pre-wrap text-muted-foreground">
                <span className="font-semibold text-foreground">{b.split('\n')[0]}</span>
                {'\n'}
                {b.split('\n').slice(1).join('\n')}
              </div>
            ))}
          </div>
          <WhatIfResult whatIf={whatIf} removed={removed} offsets={offsets} ourKey={feed?.ourKey ?? null} />
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">The questions</summary>
            <ul className="mt-1.5 flex flex-col gap-1 font-mono text-[11px]">
              {feed && Object.entries(feed.questions).map(([k, q]) => <li key={k}><b className="text-foreground">{k}</b> (feed, noul): {(q as { instructions: string }).instructions}</li>)}
              {Object.entries(PAGE_QUESTIONS).map(([k, q]) => <li key={k}><b className="text-foreground">{k}</b> (page, {q.type}): {q.instructions}</li>)}
            </ul>
          </details>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Every impression across rounds · raw → calibrated, the bar's tick is the dice
          </h3>
          <div className="max-h-[460px] overflow-y-auto">
            <table className="w-full text-[11.5px]">
              <thead className="sticky top-0 bg-card">
                <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">When</th>
                  <th className="py-1 pr-2 font-medium">Ad</th>
                  <th className="py-1 pr-2 font-medium">Tap</th>
                  <th className="py-1 pr-2 font-medium">Stay</th>
                  <th className="py-1 pr-2 font-medium">Buy | stay</th>
                  <th className="py-1 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {[...steps].reverse().map((s) => {
                  const c = creative.get(s.creativeId);
                  return (
                    <tr key={s.tick} className="border-t border-border/60 align-top">
                      <td className="py-1.5 pr-2 font-mono text-muted-foreground">R{s.round}·D{(s.tick % ticksPerRound) + 1}</td>
                      <td className="max-w-[180px] py-1.5 pr-2">
                        <div className="truncate text-foreground" title={c?.headline}>{c?.headline ?? s.creativeId}</div>
                        {s.believes != null && <div className="font-mono text-[10px] text-muted-foreground">believes {pct(s.believes, 0)}</div>}
                      </td>
                      <td className="py-1.5 pr-2"><Prob raw={s.tap.raw} cal={s.tap.cal} draw={s.tap.draw} /></td>
                      <td className="py-1.5 pr-2">{s.stay ? <Prob raw={s.stay.raw} cal={s.stay.cal} draw={s.stay.draw} /> : '–'}</td>
                      <td className="py-1.5 pr-2">
                        {s.buy ? <Prob raw={s.buy.raw} cal={s.buy.cal} draw={s.buy.draw} /> : '–'}
                        {s.buy?.guarded && <div className="text-[10px] text-status-warning">over budget</div>}
                      </td>
                      <td className="py-1.5">
                        <div className="text-foreground">{words(s.pageAction && s.pageAction !== 'not_tapped' ? s.pageAction : s.action)}</div>
                        {s.objection && <div className="text-[10px] text-muted-foreground">{words(s.objection)}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function Prob({ raw, cal, draw }: { raw: number; cal: number; draw: number | null }) {
  return (
    <div className="flex flex-col gap-0.5 font-mono tabular-nums">
      <span>
        <span className="text-muted-foreground">{pct(raw, 0)} →</span> <span className="text-foreground">{pct(cal)}</span>
      </span>
      <span className="relative inline-block h-1 w-16 rounded-full bg-secondary">
        <span className="absolute inset-y-0 left-0 rounded-full bg-chart-1" style={{ width: `${Math.max(1.5, cal * 100)}%` }} />
        {draw != null && <span className="absolute -top-0.5 h-2 w-px bg-foreground" style={{ left: `${draw * 100}%` }} title={`dice ${draw.toFixed(3)}`} />}
      </span>
    </div>
  );
}

function WhatIfResult({ whatIf, removed, offsets, ourKey }: { whatIf: WhatIf; removed: string | null; offsets: Offsets | undefined; ourKey: string | null }) {
  if (whatIf.status === 'idle') return null;
  if (whatIf.status === 'loading') return <p className="text-xs text-muted-foreground">Re-asking Jev with and without that line…</p>;
  if (whatIf.status === 'error') return <p className="text-xs text-status-error">What-if failed: {whatIf.message}</p>;
  const o = offsets ?? { tap: 0, stay: 0, buy: 0 };
  const noul = (a: Asked | null, k: string) => a?.answers[k]?.noul ?? null;
  const rows: { label: string; with: number | null; without: number | null; offset: number }[] = [
    { label: 'P(tap) our ad', with: ourKey ? noul(whatIf.with.feed, ourKey) : null, without: ourKey ? noul(whatIf.without.feed, ourKey) : null, offset: o.tap },
    { label: 'P(stay)', with: noul(whatIf.with.page, 'stays'), without: noul(whatIf.without.page, 'stays'), offset: o.stay },
    { label: 'P(buy | stay)', with: noul(whatIf.with.page, 'buys'), without: noul(whatIf.without.page, 'buys'), offset: o.buy },
  ];
  const objection = (a: Asked) => {
    const p = a.answers.objection?.probabilities ?? {};
    const top = Object.entries(p).sort((x, y) => y[1] - x[1])[0];
    return top ? `${words(top[0])} ${pct(top[1], 0)}` : '–';
  };
  const cached = [whatIf.with.feed, whatIf.without.feed, whatIf.with.page, whatIf.without.page].filter((a): a is Asked => a != null);
  return (
    <div className="rounded-lg border border-status-warning/30 bg-status-warning-soft/40 p-3 text-xs">
      <p className="mb-2 text-muted-foreground">
        Without <span className="text-foreground">“{removed}”</span>
      </p>
      <table className="w-full font-mono tabular-nums">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            <th className="pb-1 font-medium" />
            <th className="pb-1 font-medium">with (cal)</th>
            <th className="pb-1 font-medium">without (cal)</th>
            <th className="pb-1 font-medium">change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const a = r.with != null ? calibrate(r.with, r.offset) : null;
            const b = r.without != null ? calibrate(r.without, r.offset) : null;
            return (
              <tr key={r.label}>
                <td className="py-0.5 pr-2 font-sans text-muted-foreground">{r.label}</td>
                <td className="py-0.5 pr-2">{pct(a, 2)} <span className="text-muted-foreground">({pct(r.with, 0)})</span></td>
                <td className="py-0.5 pr-2 text-foreground">{pct(b, 2)} <span className="text-muted-foreground">({pct(r.without, 0)})</span></td>
                <td className="py-0.5">{a && b ? `×${(b / a).toFixed(2)}` : '–'}</td>
              </tr>
            );
          })}
          <tr>
            <td className="py-0.5 pr-2 font-sans text-muted-foreground">Top objection</td>
            <td className="py-0.5 pr-2">{objection(whatIf.with.page)}</td>
            <td className="py-0.5 pr-2 text-foreground">{objection(whatIf.without.page)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[10.5px] text-muted-foreground">
        {cached.filter((a) => a.cached).length} of {cached.length} answers from the route's cache · calibrated with this run's offsets
      </p>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Counterfactual, PinnedCapture, PinnedImpression } from '../_lib/pinned';
import { calibrate, pct, words } from '../_lib/format';
import { withoutLine } from '../_lib/selectors';
import { type Asked, ask } from '../_lib/whatif';

// The pinned shopper (B6, demo beat 3): the same recipe in two rounds, how differently they
// reacted, the one line in what Jev read that explains it, and the proof. Everything shown comes
// from the frozen capture (sim/demo/pinned-shopper.json), so it works offline; "re-ask live"
// repeats the what-if through Jev.

const ratio = (a: number, b: number) => (a > 0 && b > 0 ? `×${(b / a).toFixed(2)}` : '–');

function Card({ title, imp, ticksPerRound }: { title: string; imp: PinnedImpression; ticksPerRound: number }) {
  const outcome = imp.page.action !== 'not_tapped' ? imp.page.action : imp.feed.action;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-background/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          round {imp.round} · day {(imp.tick % ticksPerRound) + 1}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 font-mono text-xs tabular-nums">
        <dt className="font-sans text-muted-foreground">P(tap)</dt>
        <dd className="text-foreground">{pct(imp.feed.tap_cal, 2)}</dd>
        <dt className="font-sans text-muted-foreground">P(stay)</dt>
        <dd className="text-foreground">{pct(imp.page.stay_cal, 1)}</dd>
        <dt className="font-sans text-muted-foreground">P(buy | stay)</dt>
        <dd className="text-foreground">{imp.page.guard ? pct(imp.page.buy_cal, 2) : 'over budget'}</dd>
        <dt className="font-sans text-muted-foreground">Held back by</dt>
        <dd className="text-foreground">{words(imp.page.objection) || '–'}</dd>
        <dt className="font-sans text-muted-foreground">What happened</dt>
        <dd className="text-foreground">{words(outcome)}</dd>
      </dl>
    </div>
  );
}

export function PinnedStory({ capture, ticksPerRound }: { capture: PinnedCapture; ticksPerRound: number }) {
  const { before, after, reason, counterfactuals: cf, run } = capture;
  const [live, setLive] = useState<{ status: 'idle' | 'loading' } | { status: 'error'; message: string } | { status: 'done'; feed: Asked; page: Asked }>({
    status: 'idle',
  });
  const change = reason.kind === 'need' ? 'started shopping for cereal' : 'had seen more Magic Spoon ads on the same theme';

  // The what-if, live: the "after" states without the reason line, through the cached route.
  const reaskLive = async () => {
    setLive({ status: 'loading' });
    try {
      const [feed, page] = await Promise.all([
        ask(withoutLine(after.feed.state, reason.after), after.feed.questions),
        ask(withoutLine(after.page.state, reason.after), after.page.questions),
      ]);
      setLive({ status: 'done', feed, page });
    } catch (err) {
      setLive({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
  const liveCf: Counterfactual | null =
    live.status === 'done'
      ? {
          tap_cal: calibrate(live.feed.answers[after.feed.our_key]?.noul ?? 0, run.offsets.tap),
          stay_cal: calibrate(live.page.answers.stays?.noul ?? 0, run.offsets.stay),
          buy_cal: after.page.guard ? calibrate(live.page.answers.buys?.noul ?? 0, run.offsets.buy) : 0,
        }
      : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand/5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="text-[10px]">pinned</Badge>
        <p className="text-sm text-foreground">
          Same ad (<span className="text-muted-foreground">{capture.arm.label}</span>, “{before.headline.replace(/^["“](.*)["”]$/, '$1')}”), round {before.round} → round {after.round}:{' '}
          {capture.shopper.display_name} {change}.
        </p>
      </div>

      <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr]">
        <Card title="Before" imp={before} ticksPerRound={ticksPerRound} />
        <div className="flex flex-col items-center justify-center gap-1 font-mono text-[11px] text-muted-foreground">
          <span>tap {ratio(before.feed.tap_cal, after.feed.tap_cal)}</span>
          <span>stay {ratio(before.page.stay_cal, after.page.stay_cal)}</span>
          <span>buy {before.page.guard && after.page.guard ? ratio(before.page.buy_cal, after.page.buy_cal) : '–'}</span>
        </div>
        <Card title="After" imp={after} ticksPerRound={ticksPerRound} />
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-border bg-background/60 p-3 font-mono text-[11.5px]">
        <span className="font-sans text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">The line that changed in what Jev read</span>
        <span className="text-muted-foreground line-through decoration-status-error/70">{reason.before}</span>
        <span className="text-status-success">{reason.after}</span>
      </div>

      {cf && (
        <div className="grid gap-2 text-xs md:grid-cols-2">
          <p className="text-muted-foreground">
            <b className="text-foreground">Proof:</b> put the old line back into the round {after.round} state and Jev answers P(tap){' '}
            <span className="font-mono text-foreground">{pct(cf.reverted.tap_cal, 2)}</span>, P(buy | stay){' '}
            <span className="font-mono text-foreground">{pct(cf.reverted.buy_cal, 2)}</span>
            {reason.explained !== null && <> — the line explains {Math.round(Math.min(1, reason.explained) * 100)}% of the change</>}.
          </p>
          <p className="text-muted-foreground">
            <b className="text-foreground">What-if:</b> say nothing about {reason.kind === 'need' ? 'shopping' : 'past ads'} instead (drop the line), and P(tap) is{' '}
            <span className="font-mono text-foreground">{pct((liveCf ?? cf.removed).tap_cal, 2)}</span>, P(buy | stay){' '}
            <span className="font-mono text-foreground">{pct((liveCf ?? cf.removed).buy_cal, 2)}</span>
            {live.status === 'done' ? ` (live, ${[live.feed, live.page].filter((a) => a.cached).length} of 2 from the route's cache)` : ' (from the capture)'}.{' '}
            <Button size="sm" variant="outline" className="ml-1 h-6 px-2 text-[11px]" onClick={reaskLive} disabled={live.status === 'loading'}>
              {live.status === 'loading' ? 'asking Jev…' : 're-ask live'}
            </Button>
            {live.status === 'error' && <span className="ml-2 text-status-error">{live.message}</span>}
          </p>
        </div>
      )}

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          Also different between the two days ({reason.confounders.length}) and the exact text Jev read
        </summary>
        {reason.confounders.length > 0 && (
          <ul className="mt-2 flex flex-col gap-0.5 font-mono text-[11px]">
            {reason.confounders.map((l) => (
              <li key={l} className="truncate" title={l}>
                · {l}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {[before, after].map((imp, i) => (
            <pre
              key={i}
              className={cn('max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 p-2 font-mono text-[10.5px] leading-relaxed')}
            >
              {`${i ? 'AFTER' : 'BEFORE'} · feed call\n\n${imp.feed.state}`}
            </pre>
          ))}
        </div>
      </details>
    </div>
  );
}

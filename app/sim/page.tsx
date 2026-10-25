'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Activity } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EyebrowChip } from '@/components/ui/eyebrow-chip';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useSimData } from './_lib/useSimData';
import {
  type RunCalibration,
  armColors,
  headerStats,
  leaderboard,
  learningsFeed,
  riverSeries,
  shopperHistory,
  ticker,
} from './_lib/selectors';
import { parseJson } from './_lib/format';
import { type PinnedCapture, pinnedFor } from './_lib/pinned';
import pinnedCapture from '@/sim/demo/pinned-shopper.json';
import adImages from '@/sim/demo/ad-images.json';
import { type AdImages, AdGallery } from './_components/AdGallery';
import { imageRunFor, runSignature } from './_lib/adImages';
import { databaseLabel, isLocalDatabase } from './_components/SimProvider';
import { HeaderStrip } from './_components/HeaderStrip';
import AllocationRiver from './_components/AllocationRiver';
import { Section } from './_components/Section';
import { Leaderboard } from './_components/Leaderboard';
import { DecisionTicker } from './_components/DecisionTicker';
import { ShopperInspector } from './_components/ShopperInspector';
import { LearningsFeed } from './_components/LearningsFeed';

function SimPage() {
  const router = useRouter();
  const params = useSearchParams();
  const data = useSimData(params.get('run'));
  const { run, runs, runsReady, conn } = data;

  const stats = useMemo(() => headerStats(run, data.rounds, data.decisions), [run, data.rounds, data.decisions]);
  const river = useMemo(() => riverSeries(data.decisions, data.creatives, data.arms), [data.decisions, data.creatives, data.arms]);
  const ticksPerRound = run?.ticksPerRound ?? 3;
  const ticks = ((run?.roundsPlanned ?? 0) + 1) * ticksPerRound;
  const colors = useMemo(() => armColors(data.arms), [data.arms]);
  const boards = useMemo(() => leaderboard(data.armStats, data.arms, data.segments), [data.armStats, data.arms, data.segments]);
  const shopperNames = useMemo(() => new Map(data.shoppers.map((s) => [s.shopperId, s.displayName])), [data.shoppers]);
  const tickerRows = useMemo(
    () => ticker(data.decisions, data.creatives, data.brands, shopperNames),
    [data.decisions, data.creatives, data.brands, shopperNames],
  );
  const learnings = useMemo(() => learningsFeed(data.learnings, data.creatives), [data.learnings, data.creatives]);
  // The pinned shopper (sim:pin) belongs to this run when its captured states are this run's.
  const pinned = useMemo(() => pinnedFor(pinnedCapture as unknown as PinnedCapture, data.decisions), [data.decisions]);
  // The run whose ad images apply here: this run, or the run it replays (same signature).
  const imageRun = useMemo(() => {
    const sidecar = adImages as AdImages;
    const has = (id: string) => Object.values(sidecar.images).some((e) => e.run_id === id);
    const feed = data.decisions.filter((d) => d.kind === 'feed').map((d) => ({ tick: d.tick, shopper: d.shopperId, options: d.options }));
    return run ? imageRunFor(run.runId, feed.length ? runSignature(feed) : '', sidecar.runs ?? {}, has) : null;
  }, [run, data.decisions]);
  // The inspector opens on the pinned shopper, else follows the newest impression, until someone
  // picks a shopper.
  const [picked, setPicked] = useState<string | null>(null);
  const shopperId = picked ?? pinned?.shopper.shopper_id ?? tickerRows[0]?.shopperId ?? null;
  const shopper = data.shoppers.find((s) => s.shopperId === shopperId);
  const steps = useMemo(() => (shopperId ? shopperHistory(data.decisions, shopperId) : []), [data.decisions, shopperId]);
  const offsets = useMemo(() => parseJson<RunCalibration>(run?.calibration, {}).offsets, [run?.calibration]);

  return (
    <>
      <PageHeader
        eyebrow={<EyebrowChip icon={Activity}>{isLocalDatabase ? 'Local bench' : 'Maincloud'} · {databaseLabel}</EyebrowChip>}
        title="Live sim"
        description="Ad recipes tested on Jev-driven shoppers. Every number arrives over a SpacetimeDB subscription as the worker writes each sim day."
        actions={
          <div className="flex items-center gap-3">
            {runs.length > 0 && (
              <select
                aria-label="Run"
                className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs"
                value={run?.runId ?? ''}
                onChange={(e) => router.replace(`/sim?run=${encodeURIComponent(e.target.value)}`)}
              >
                {[...runs]
                  .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch))
                  .map((r) => (
                    <option key={r.runId} value={r.runId}>
                      {r.runId} · {r.status}
                    </option>
                  ))}
              </select>
            )}
            <Link href="/sim/dev" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Test bench →
            </Link>
          </div>
        }
      />
      {conn.connectionError && (
        <div className="rounded-lg border border-status-error/30 bg-status-error-soft px-4 py-3 text-sm text-status-error">
          Could not reach {databaseLabel}: {conn.connectionError.message}
        </div>
      )}
      <HeaderStrip stats={stats} connected={conn.isActive} />
      {!runsReady ? (
        <Skeleton className="h-64 w-full" />
      ) : !run ? (
        <Card className="items-center px-6 py-12 text-center text-sm text-muted-foreground">
          No runs yet. The views fill as soon as A starts a run and the sim worker writes its first sim day.
        </Card>
      ) : (
        <>
          <Section title="Allocation river" hint="impressions per recipe per sim day">
            <AllocationRiver series={river.series} ticks={ticks} ticksPerRound={ticksPerRound} />
          </Section>
          <Section title="Leaderboard" hint="per segment · cost per order = $13.88 CPM / 1000 / expected reward">
            <Leaderboard boards={boards} colors={colors} />
          </Section>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Section title="Decision ticker" hint="latest 50 impressions · calibrated chance and the dice">
              <DecisionTicker
                rows={tickerRows}
                ticksPerRound={ticksPerRound}
                selected={shopperId}
                pinnedId={pinned?.shopper.shopper_id ?? null}
                onSelect={setPicked}
              />
            </Section>
            <Section title="Learnings" hint={`${learnings.filter((l) => l.live).length} live · ${learnings.length} written`}>
              <LearningsFeed items={learnings} segments={data.segments} />
            </Section>
          </div>
          <Section title="Ads" hint="the run's top round-0 ads and each segment's winner, rendered for display (the sim reads text only)">
            <AdGallery images={adImages as AdImages} runId={run.runId} sourceRun={imageRun} creatives={data.creatives} arms={data.arms} segments={data.segments} />
          </Section>
          <Section
            title="Shopper inspector"
            hint={
              <select
                aria-label="Shopper"
                className="h-7 rounded-md border border-border bg-background px-2 font-mono text-xs"
                value={shopperId ?? ''}
                onChange={(e) => setPicked(e.target.value)}
              >
                {[...data.shoppers]
                  .sort((a, b) => a.shopperId.localeCompare(b.shopperId))
                  .map((s) => (
                    <option key={s.shopperId} value={s.shopperId}>
                      {s.shopperId} · {s.displayName}
                    </option>
                  ))}
              </select>
            }
          >
            <ShopperInspector
              shopper={shopper}
              steps={steps}
              creatives={data.creatives}
              brands={data.brands}
              segments={data.segments}
              offsets={offsets}
              ticksPerRound={ticksPerRound}
              pinned={pinned && pinned.shopper.shopper_id === shopperId ? pinned : null}
            />
          </Section>
        </>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <SimPage />
    </Suspense>
  );
}

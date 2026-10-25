'use client';

import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ArmRow, CreativeRow, SegmentRow } from '@/lib/spacetime/bindings/types';
import { armLabel } from '../_lib/selectors';
import { usd } from '../_lib/format';

// Pictures of the demo's ads (display only: the sim itself is text-only). `npm run sim:images`
// renders the run's top round-0 ads and each segment's winning ad and maps them in
// sim/demo/ad-images.json; the files are served by /api/sim/ad-image/<creative_id>.

export type AdImages = {
  version: 1;
  runs?: Record<string, { signature: string }>;
  images: Record<
    string,
    {
      run_id: string;
      segment_id: string;
      arm_id: string;
      round0?: { rank: number; mean_reward: number; impressions: number };
      winner?: { mean_reward: number; impressions: number; cpo_usd: number | null; control_cpo_usd: number | null };
      created_at?: string;
    }
  >;
};

// sourceRun: the run the images were rendered for (this run, or the run it replays); see imageRunFor.
type Props = { images: AdImages; runId: string; sourceRun: string | null; creatives: readonly CreativeRow[]; arms: readonly ArmRow[]; segments: readonly SegmentRow[] };

// `version` (the image's created_at) changes the URL when an image is re-rendered under the same id,
// so the browser doesn't keep showing its cached copy.
function AdCard({ id, version, creative, children }: { id: string; version?: string; creative: CreativeRow | undefined; children: React.ReactNode }) {
  return (
    <figure className="flex flex-col overflow-hidden rounded-lg border border-border bg-background/60">
      {/* eslint-disable-next-line @next/next/no-img-element -- local, already-sized PNGs */}
      <img src={`/api/sim/ad-image/${id}${version ? `?v=${encodeURIComponent(version)}` : ''}`} alt={creative?.visualDescription ?? id} loading="lazy" className="aspect-square w-full object-cover" />
      <figcaption className="flex flex-col gap-1.5 p-3 text-xs">
        <b className="text-sm font-semibold leading-snug text-foreground">{creative?.headline ?? id}</b>
        {creative?.primaryText && <p className="line-clamp-3 text-muted-foreground">{creative.primaryText}</p>}
        {children}
      </figcaption>
    </figure>
  );
}

export function AdGallery({ images, runId, sourceRun, creatives, arms, segments }: Props) {
  const creative = new Map(creatives.map((c) => [c.creativeId, c]));
  const arm = new Map(arms.map((a) => [a.armId, a]));
  const segment = new Map(segments.map((s) => [s.segmentId, s.name]));
  const entries = Object.entries(images.images).filter(([, e]) => e.run_id === sourceRun);
  const winners = entries.filter(([, e]) => e.winner).sort(([, a], [, b]) => (segment.get(a.segment_id) ?? '').localeCompare(segment.get(b.segment_id) ?? ''));
  const round0 = entries.filter(([, e]) => e.round0).sort(([, a], [, b]) => a.round0!.rank - b.round0!.rank);

  if (!entries.length) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No ad images for this run yet: <code className="font-mono text-xs">npm run sim:images -- round0 --run {runId}</code>, then{' '}
        <code className="font-mono text-xs">winners</code>.
      </p>
    );
  }
  return (
    <Tabs defaultValue={winners.length ? 'winners' : 'round0'} className="gap-3">
      {sourceRun !== runId && (
        <p className="text-xs text-muted-foreground">
          This run replays <span className="font-mono">{sourceRun}</span> exactly, so it shows that run's images.
        </p>
      )}
      <TabsList>
        <TabsTrigger value="winners" className="text-xs" disabled={!winners.length}>
          Winners by segment ({winners.length})
        </TabsTrigger>
        <TabsTrigger value="round0" className="text-xs" disabled={!round0.length}>
          Top round-0 ads ({round0.length})
        </TabsTrigger>
      </TabsList>
      <TabsContent value="winners">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {winners.map(([id, e]) => (
            <AdCard key={id} id={id} version={e.created_at} creative={creative.get(id)}>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[10px]">{segment.get(e.segment_id) ?? e.segment_id}</Badge>
                <Badge variant="outline" className="text-[10px]">{armLabel(arm.get(e.arm_id))}</Badge>
              </div>
              <p className="font-mono tabular-nums text-muted-foreground">
                <span className="text-foreground">{usd(e.winner!.cpo_usd)}</span> per order vs {usd(e.winner!.control_cpo_usd)} for current ads ·{' '}
                {e.winner!.impressions} impressions
              </p>
            </AdCard>
          ))}
        </div>
      </TabsContent>
      <TabsContent value="round0">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {round0.map(([id, e]) => (
            <AdCard key={id} id={id} version={e.created_at} creative={creative.get(id)}>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className="text-[10px]">#{e.round0!.rank}</Badge>
                <Badge variant="secondary" className="text-[10px]">{segment.get(e.segment_id) ?? e.segment_id}</Badge>
              </div>
              <p className="text-muted-foreground">{armLabel(arm.get(e.arm_id))}</p>
              <p className="font-mono tabular-nums text-muted-foreground">
                warm-up reward {(e.round0!.mean_reward * 1e4).toFixed(1)}×10⁻⁴ · {e.round0!.impressions} impressions
              </p>
            </AdCard>
          ))}
        </div>
      </TabsContent>
    </Tabs>
  );
}

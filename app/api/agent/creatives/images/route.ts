import { z } from 'zod';
import { renderAdImages, type RenderResult } from '@/lib/adlab/ad-images';
import { getSpacetime, getSupabase } from '@/lib/adlab/agent-runtime';
import { getBrandKit, kitImageDataUrl } from '@/lib/adlab/brand-kit';
import { ApiError, handle, parseJson, requireRunsAllowed } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const Body = z.object({ run_id: z.string().regex(/^run_[a-z0-9_]{1,40}$/) });

// One render per run at a time: a repeat call (the Copywriter retrying after a timeout) joins it.
const inFlight: Map<string, Promise<RenderResult>> = ((globalThis as { __adlabWinnerImages?: Map<string, Promise<RenderResult>> }).__adlabWinnerImages ??=
  new Map());

// POST /api/agent/creatives/images (docs/AGENT_API.md): the Copywriter renders each segment's winning
// ad with the brand kit's product photo, after the last round. Images land in data/ad-images/ and
// sim/demo/ad-images.json, which /sim shows. not_ready (409) without a brand kit photo.
export const POST = handle(async (req) => {
  const { run_id } = await parseJson(req, Body);
  requireRunsAllowed();
  const spacetime = await getSpacetime();
  const kit = await getBrandKit(spacetime).catch(() => null);
  const dataUrl = kit ? await kitImageDataUrl(kit) : null;
  if (!kit || !dataUrl) throw new ApiError('not_ready', 'no brand kit photo: set it at /start');
  let job = inFlight.get(run_id);
  if (!job) {
    job = renderAdImages({
      spacetime,
      db: getSupabase(),
      runId: run_id,
      mode: 'winners',
      maxUsd: 1,
      concurrency: 5,
      reference: { dataUrl, sha: kit.image_sha },
      log: (line) => console.log(line),
    }).finally(() => inFlight.delete(run_id));
    inFlight.set(run_id, job);
  }
  const result = await job;
  // An absolute image URL only with a public base (a tunnel): ASI:One cards can't load localhost.
  const base = process.env.ADLAB_PUBLIC_BASE_URL?.trim().replace(/\/$/, '') ?? '';
  const pick = (...statuses: string[]) =>
    result.images
      .filter((i) => statuses.includes(i.status))
      .map(({ creative_id, segment_id }) => ({ creative_id, segment_id, image_url: base ? `${base}/api/sim/ad-image/${creative_id}` : '' }));
  return {
    run_id,
    rendered: pick('rendered', 'have'),
    failed: result.images.filter((i) => i.status === 'failed' || i.status === 'mismatch').map(({ creative_id, error }) => ({ creative_id, error: error ?? 'pack mismatch' })),
    cost_usd: Math.round(result.spent_cents) / 100,
    with_reference: result.with_reference,
  };
});

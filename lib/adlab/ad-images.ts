import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { sqlString, type Spacetime } from '@/lib/adlab/spacetime-http';
import { compile } from '@/lib/creative-engine/brand-context/compile';
import { renderImagePrompt } from '@/lib/creative-engine/brand-context/renderers';
import type { BrandContextPack, BrandContextRow, CompileSpec } from '@/lib/creative-engine/brand-context/types';
import { composeBrief } from '@/lib/creative-engine/generation/brief-composer';
import { selectStrategyGroups } from '@/lib/creative-engine/generation/pipeline-stages';
import { createOpenAIImageProvider } from '@/lib/creative-engine/generation/providers/openai-image';
import { keyMessageFor, loadClientRows, personaAudience, personaRefFor, valuePropositions } from '@/worker/creatives/facts';
import { derivePackHints, segmentRows } from '@/worker/creatives/pack-hints';
import { strategyFromArms } from '@/worker/creatives/strategy-from-arms';
import { runSignature } from '@/app/sim/_lib/adImages';
import { type Ad, type ArmStat, type Decision, topRound0, winners } from '@/scripts/sim-images-select';

/*
 * Images for the demo's ads, display only (the sim stays text-only: Jev takes no images). Shared by
 * `npm run sim:images` (scripts/sim-images.ts) and the Copywriter's POST /api/agent/creatives/images.
 *
 * Reads SpacetimeDB (SQL only) and A's brand facts in Supabase (read-only). Rebuilds each ad's pack
 * the way A5 compiled it (worker/creatives/brief.ts, minus the copy calls), checks it against the
 * creative's pack_fingerprint, renders Adcero's image prompt plus the ad's own visual line with
 * gpt-image-2 at medium quality, and saves data/ad-images/<creative_id>.png. With the brand kit's
 * product photo as a reference, the checked pack gains a product_image asset, so the prompt asks
 * for the real packaging exactly, and the photo goes to OpenAI's edits endpoint. sim/demo/ad-images.json
 * maps each creative to its image, so A's creative.image_url is never written.
 */

const GOAL = 'conversions';
const PLATFORM = 'meta';
const SIZE = { width: 1024, height: 1024 };
const QUALITY = 'medium' as const;
export const IMAGE_DIR = path.resolve('data/ad-images');
export const SIDECAR = path.resolve('sim/demo/ad-images.json');

// runs: each source run's signature, so its replays show the same images (app/sim/_lib/adImages.ts).
type Sidecar = { version: 1; runs?: Record<string, { signature: string }>; images: Record<string, SidecarEntry> };
// One image per creative; each set it was picked for keeps its own numbers.
type SidecarEntry = {
  file: string;
  run_id: string;
  segment_id: string;
  arm_id: string;
  round0?: { rank: number; mean_reward: number; impressions: number };
  winner?: { mean_reward: number; impressions: number; cpo_usd: number | null; control_cpo_usd: number | null };
  /** The brand kit photo's sha256 when the image was rendered from it. */
  reference_sha?: string;
  prompt: string;
  model: string;
  quality: string;
  size: string;
  cost_cents: number;
  created_at: string;
};

export type ImageMode = 'round0' | 'winners';

export interface RenderOptions {
  spacetime: Spacetime;
  db: SupabaseClient;
  runId: string;
  mode: ImageMode;
  /** round0: how many of the top warm-up ads. Default 15. */
  top?: number;
  limit?: number;
  maxUsd?: number;
  dry?: boolean;
  /** Re-render images already on disk. */
  force?: boolean;
  /** The product photo as a data: URL (lib/adlab/brand-kit.ts kitImageDataUrl), and its sha256. */
  reference?: { dataUrl: string; sha: string } | null;
  /** How many images render at once. Default 1 (the CLI); the Copywriter's route uses 5. */
  concurrency?: number;
  log?: (line: string) => void;
}

export interface RenderedImage {
  creative_id: string;
  segment_id: string;
  arm_id: string;
  status: 'rendered' | 'have' | 'would_render' | 'mismatch' | 'over_budget' | 'failed';
  error?: string;
}

export interface RenderResult {
  run_id: string;
  mode: ImageMode;
  images: RenderedImage[];
  spent_cents: number;
  mismatches: number;
  with_reference: boolean;
}

type Recipe = { angle: string; hook: string };
type Context = { rows: BrandContextRow[]; brandProfileId: string; brandName: string; recipes: Map<string, Recipe> };
type CreativeRow = Ad & Record<string, string>;

export async function renderAdImages(opts: RenderOptions): Promise<RenderResult> {
  const { spacetime, runId, mode } = opts;
  const log = opts.log ?? (() => {});
  log(`[images] reading ${spacetime.label} (SQL only), run ${runId}`);

  const ads = (await spacetime.sql<CreativeRow>('SELECT * FROM creative')) as CreativeRow[];
  const decisions = await spacetime.sql<Decision>(`SELECT * FROM decision WHERE run_id = ${sqlString(runId)}`);
  if (!decisions.length) throw new Error(`run ${runId} has no decisions on ${spacetime.label}`);
  const armRows = await spacetime.sql<{ arm_id: string; strategy: string; angle: string; hook: string }>('SELECT * FROM arm');
  const control = armRows.find((a) => a.strategy === 'control')!;
  const brandName = (await spacetime.sql<{ name: string; is_client: boolean }>('SELECT * FROM brand')).find((b) => b.is_client)?.name ?? '';

  type Pick = { creative_id: string; rank: number | null; mean: number; n: number; cpo: number | null; control_cpo: number | null };
  let picks: Pick[];
  if (mode === 'round0') {
    picks = topRound0(decisions, ads, opts.top ?? 15).map((s, i) => ({ ...s, rank: i + 1, cpo: null, control_cpo: null }));
  } else {
    const stats = await spacetime.sql<ArmStat>(`SELECT * FROM arm_stat WHERE run_id = ${sqlString(runId)}`);
    const shoppers = await spacetime.sql<{ shopper_id: string; segment_id: string }>(`SELECT * FROM shopper WHERE run_id = ${sqlString(runId)}`);
    picks = winners(decisions, ads, stats, new Map(shoppers.map((s) => [s.shopper_id, s.segment_id])), control.arm_id).map((w) => ({
      ...w,
      rank: null,
    }));
  }
  const limit = opts.limit ?? picks.length;
  log(`[images] ${picks.length} ${mode} ads selected${limit < picks.length ? `, rendering the first ${limit}` : ''}${opts.reference ? ', with the brand kit photo' : ''}`);

  const { rows, brandProfileId } = await loadClientRows(opts.db);
  const ctx: Context = { rows, brandProfileId, brandName, recipes: new Map(armRows.map((a) => [a.arm_id, { angle: a.angle, hook: a.hook }])) };
  const provider = createOpenAIImageProvider();
  const unit = provider.estimateCostCents({ ...SIZE, quality: QUALITY });
  const maxCents = Math.round((opts.maxUsd ?? 2) * 100);
  const sidecar: Sidecar = existsSync(SIDECAR) ? JSON.parse(readFileSync(SIDECAR, 'utf8')) : { version: 1, images: {} };
  mkdirSync(IMAGE_DIR, { recursive: true });
  const feed = decisions.filter((d) => d.kind === 'feed').map((d) => ({ tick: d.tick, shopper: d.shopper_id, options: String((d as Record<string, unknown>).options) }));
  sidecar.runs = { ...sidecar.runs, [runId]: { signature: runSignature(feed) } };
  const saveSidecar = () => writeFileSync(SIDECAR, `${JSON.stringify(sidecar, null, 2)}\n`);

  const images: RenderedImage[] = [];
  let spent = 0;
  const jobs: Array<() => Promise<void>> = [];

  for (const pick of picks.slice(0, limit)) {
    const ad = ads.find((a) => a.creative_id === pick.creative_id)!;
    const out = (status: RenderedImage['status'], error?: string) =>
      images.push({ creative_id: ad.creative_id, segment_id: ad.segment_id, arm_id: ad.arm_id, status, ...(error ? { error } : {}) });
    const file = path.join(IMAGE_DIR, `${ad.creative_id}.png`);
    const prompt = promptFor(ad, ads, ctx, !!opts.reference);
    if (!prompt) {
      out('mismatch');
      log(`  skip ${ad.creative_id}: rebuilt pack doesn't match its pack_fingerprint`);
      continue;
    }
    const label = `${pick.rank ? `#${pick.rank} ` : ''}${ad.creative_id} (reward ${(pick.mean * 1e4).toFixed(1)}e-4, n=${pick.n})`;
    const old = sidecar.images[ad.creative_id];
    const entry = (cost: number, model: string, referenceSha?: string): SidecarEntry => ({
      file: path.relative(process.cwd(), file),
      run_id: runId,
      segment_id: ad.segment_id,
      arm_id: ad.arm_id,
      ...(old?.run_id === runId ? { round0: old.round0, winner: old.winner } : {}),
      ...(mode === 'round0'
        ? { round0: { rank: pick.rank!, mean_reward: pick.mean, impressions: pick.n } }
        : { winner: { mean_reward: pick.mean, impressions: pick.n, cpo_usd: pick.cpo, control_cpo_usd: pick.control_cpo } }),
      ...(referenceSha ? { reference_sha: referenceSha } : {}),
      prompt,
      model,
      quality: QUALITY,
      size: `${SIZE.width}x${SIZE.height}`,
      cost_cents: cost,
      created_at: old?.created_at ?? new Date().toISOString(),
    });
    // An image already rendered from this same photo is kept; one rendered without it (or from an
    // older photo) is redone when a reference is given.
    const current = existsSync(file) && (!opts.reference || old?.reference_sha === opts.reference.sha);
    if (current && !opts.force) {
      sidecar.images[ad.creative_id] = entry(old?.cost_cents ?? 0, old?.model ?? provider.model, old?.reference_sha);
      out('have');
      log(`  have ${label}`);
      continue;
    }
    if (opts.dry) {
      out('would_render');
      log(`  would render ${label}, ~${unit}¢\n    ${prompt.slice(0, 300)}…`);
      spent += unit;
      continue;
    }
    if (spent + unit > maxCents) {
      out('over_budget');
      log(`  stop: the next image would pass the $${(maxCents / 100).toFixed(2)} budget`);
      continue;
    }
    spent += unit;
    jobs.push(async () => {
      try {
        const result = await provider.generate({
          prompt,
          ...SIZE,
          quality: QUALITY,
          ...(opts.reference ? { referenceImages: [opts.reference.dataUrl] } : {}),
          signal: AbortSignal.timeout(180_000),
        });
        writeFileSync(file, result.imageBuffer);
        sidecar.images[ad.creative_id] = entry(unit, result.model, opts.reference?.sha);
        saveSidecar();
        out('rendered');
        log(`  rendered ${label} → ${path.relative(process.cwd(), file)}`);
      } catch (error) {
        spent -= unit;
        const message = error instanceof Error ? error.message : String(error);
        out('failed', message.slice(0, 300));
        log(`  failed ${label}: ${message}`);
      }
    });
  }

  const lanes = Math.max(1, opts.concurrency ?? 1);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(lanes, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }),
  );
  if (!opts.dry) saveSidecar();
  const mismatches = images.filter((i) => i.status === 'mismatch').length;
  log(`[images] ${opts.dry ? 'estimated' : 'spent'} about $${(spent / 100).toFixed(2)}; ${mismatches} fingerprint mismatches`);
  return { run_id: runId, mode, images, spent_cents: spent, mismatches, with_reference: !!opts.reference };
}

/**
 * The checked pack plus the brand kit photo as a product_image asset, so renderImagePrompt asks for
 * the real packaging exactly (lib/creative-engine/brand-context/renderers/image.ts). The asset's url
 * is a stand-in: the photo itself reaches the provider as referenceImages.
 */
export function withProductReference(pack: BrandContextPack): BrandContextPack {
  const asset = { id: 'asset_product_image_brand_kit', version: 1, content: { kind: 'product_image', id: 'brand_kit', url: 'brand-kit://product-photo' } };
  return { ...pack, slots: { ...pack.slots, assets: [...pack.slots.assets, asset] } };
}

// The pack A5 compiled for this ad, rebuilt without copy calls: one brief per (segment, angle),
// whose hooks are the recipes A5 wrote together in the same round and run (ids share the
// cr_g<round>[_<run>] tag). The spec's candidate count is the number of those hooks; if the
// fingerprint still differs, other counts are tried (compiling is deterministic and free).
// Null when nothing matches the creative's pack_fingerprint.
export function promptFor(ad: CreativeRow, ads: readonly CreativeRow[], ctx: Context, withReference = false): string | null {
  const recipe = ctx.recipes.get(ad.arm_id);
  if (!recipe) return null;
  const tagOf = (a: Ad) => a.creative_id.slice(0, a.creative_id.indexOf(`_${a.arm_id.replace(/^arm_/, '')}_${a.segment_id.replace(/^seg_/, '')}_`));
  const group = ads.filter(
    (a) =>
      a.origin === 'generated' &&
      a.round_created === ad.round_created &&
      a.segment_id === ad.segment_id &&
      tagOf(a) === tagOf(ad) &&
      ctx.recipes.get(a.arm_id)?.angle === recipe.angle,
  );
  const hooks = [...new Set(group.map((a) => ctx.recipes.get(a.arm_id)!.hook))];
  const personaRef = personaRefFor(ad.segment_id);
  const own = segmentRows(ctx.rows, personaRef);
  const persona = own.find((row) => row.rowType === 'persona');
  if (!persona) return null;
  const keyFact = keyMessageFor(own, recipe.angle, personaRef);
  const selected = strategyFromArms(
    hooks.map((hook) => ({ angle: recipe.angle, hookArchetype: hook })),
    { signals: [], packHints: derivePackHints(own), goal: GOAL, platform: PLATFORM },
  );
  const composed = composeBrief({
    organizationId: ADLAB_ORG_ID,
    brandSummary: { brandName: ctx.brandName, valuePropositions: valuePropositions(own) },
    audience: personaAudience(persona),
    ...(keyFact ? { keyMessage: String(keyFact.content.statement) } : {}),
    compliance: { prohibitedClaims: [], requiredDisclaimers: [] },
    source: 'agent',
    goal: GOAL,
    platform: PLATFORM,
    aspectRatios: ['1:1'],
    selectedStrategy: selected,
  });
  const base = selectStrategyGroups(selected.groups).length;
  for (const candidates of [base, ...Array.from({ length: 12 }, (_, i) => i + 1).filter((n) => n !== base)]) {
    const spec: CompileSpec = {
      platform: PLATFORM,
      aspectRatio: '1:1',
      goal: GOAL,
      personaRef,
      angle: composed.angle,
      candidates,
      ...(keyFact ? { keyMessageRef: keyFact.rowId } : {}),
      angleTheme: recipe.angle,
    };
    const { pack, fingerprint } = compile(spec, ctx.rows, { brandProfileId: ctx.brandProfileId });
    if (fingerprint !== ad.pack_fingerprint) continue;
    if (!withReference) return `${renderImagePrompt(pack).prompt} This ad's visual: ${ad.visual_description}. Leave out any words, logos or text overlays.`;
    return `${renderImagePrompt(withProductReference(pack)).prompt} This ad's visual: ${ad.visual_description}. No added text overlays, captions or watermarks; the only words are the ones printed on the real packaging.`;
  }
  return null;
}

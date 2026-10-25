import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { connectSpacetime, sqlString } from '@/lib/adlab/spacetime-http';
import { serviceSupabase } from '@/lib/adlab/supabase';
import { compile } from '@/lib/creative-engine/brand-context/compile';
import { renderImagePrompt } from '@/lib/creative-engine/brand-context/renderers';
import type { BrandContextRow, CompileSpec } from '@/lib/creative-engine/brand-context/types';
import { composeBrief } from '@/lib/creative-engine/generation/brief-composer';
import { selectStrategyGroups } from '@/lib/creative-engine/generation/pipeline-stages';
import { createOpenAIImageProvider } from '@/lib/creative-engine/generation/providers/openai-image';
import { keyMessageFor, loadClientRows, personaAudience, personaRefFor, valuePropositions } from '@/worker/creatives/facts';
import { derivePackHints, segmentRows } from '@/worker/creatives/pack-hints';
import { strategyFromArms } from '@/worker/creatives/strategy-from-arms';
import { type Ad, type ArmStat, type Decision, topRound0, winners } from './sim-images-select';

/*
 * B: images for the demo's ads, display only (the sim stays text-only: Jev takes no images).
 *
 *   npm run sim:images -- round0 --run <run_id> [--top 15] [--dry] [--limit N] [--max-usd 2] [--force]
 *       the top round-0 ads by reward in the run's warm-up
 *   npm run sim:images -- winners --run <run_id> [--dry] [--limit N] [--max-usd 2] [--force]
 *       per segment, the winning recipe's best ad at the end of the run
 *
 * Reads SpacetimeDB (SPACETIMEDB_URI / SPACETIMEDB_DB_NAME, SQL only) and A's brand facts in
 * Supabase (read-only). Rebuilds each ad's pack the way A5 compiled it (worker/creatives/brief.ts,
 * minus the copy calls), checks it against the creative's pack_fingerprint, renders Adcero's image
 * prompt plus the ad's own visual line with gpt-image-2 at medium quality, and saves
 * data/ad-images/<creative_id>.png. sim/demo/ad-images.json maps each creative to its image, so A's
 * creative.image_url is never written. Images already on disk are skipped.
 */

const GOAL = 'conversions';
const PLATFORM = 'meta';
const SIZE = { width: 1024, height: 1024 };
const QUALITY = 'medium' as const;
const IMAGE_DIR = path.resolve('data/ad-images');
const SIDECAR = path.resolve('sim/demo/ad-images.json');

type Sidecar = { version: 1; images: Record<string, SidecarEntry> };
// One image per creative; each set it was picked for keeps its own numbers.
type SidecarEntry = {
  file: string;
  run_id: string;
  segment_id: string;
  arm_id: string;
  round0?: { rank: number; mean_reward: number; impressions: number };
  winner?: { mean_reward: number; impressions: number; cpo_usd: number | null; control_cpo_usd: number | null };
  prompt: string;
  model: string;
  quality: string;
  size: string;
  cost_cents: number;
  created_at: string;
};

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(`--${name}`);

async function main(): Promise<number> {
  if (command !== 'round0' && command !== 'winners') {
    console.error('usage: npm run sim:images -- round0|winners --run <run_id> [--top 15] [--dry] [--limit N] [--max-usd 2] [--force]');
    return 2;
  }
  const runId = flag('run');
  if (!runId) throw new Error('--run <run_id> is required');
  const spacetime = await connectSpacetime();
  console.log(`[images] reading ${spacetime.label} (SQL only), run ${runId}`);

  const ads = (await spacetime.sql<Ad & Record<string, unknown>>('SELECT * FROM creative')) as (Ad & Record<string, string>)[];
  const decisions = await spacetime.sql<Decision>(`SELECT * FROM decision WHERE run_id = ${sqlString(runId)}`);
  if (!decisions.length) throw new Error(`run ${runId} has no decisions on ${spacetime.label}`);
  const armRows = await spacetime.sql<{ arm_id: string; strategy: string; angle: string; hook: string }>('SELECT * FROM arm');
  const control = armRows.find((a) => a.strategy === 'control')!;
  const brandName = (await spacetime.sql<{ name: string; is_client: boolean }>('SELECT * FROM brand')).find((b) => b.is_client)?.name ?? '';

  type Pick = { creative_id: string; rank: number | null; mean: number; n: number; cpo: number | null; control_cpo: number | null };
  let picks: Pick[];
  if (command === 'round0') {
    picks = topRound0(decisions, ads, Number(flag('top') ?? 15)).map((s, i) => ({ ...s, rank: i + 1, cpo: null, control_cpo: null }));
  } else {
    const stats = await spacetime.sql<ArmStat>(`SELECT * FROM arm_stat WHERE run_id = ${sqlString(runId)}`);
    const shoppers = await spacetime.sql<{ shopper_id: string; segment_id: string }>(`SELECT * FROM shopper WHERE run_id = ${sqlString(runId)}`);
    picks = winners(decisions, ads, stats, new Map(shoppers.map((s) => [s.shopper_id, s.segment_id])), control.arm_id).map((w) => ({
      ...w,
      rank: null,
    }));
  }
  const limit = flag('limit') ? Number(flag('limit')) : picks.length;
  console.log(`[images] ${picks.length} ${command} ads selected${limit < picks.length ? `, rendering the first ${limit}` : ''}`);

  const { rows, brandProfileId } = await loadClientRows(serviceSupabase());
  const ctx: Context = { rows, brandProfileId, brandName, recipes: new Map(armRows.map((a) => [a.arm_id, { angle: a.angle, hook: a.hook }])) };
  const provider = createOpenAIImageProvider();
  const unit = provider.estimateCostCents({ ...SIZE, quality: QUALITY });
  const maxCents = Math.round(Number(flag('max-usd') ?? 2) * 100);
  const sidecar: Sidecar = existsSync(SIDECAR) ? JSON.parse(readFileSync(SIDECAR, 'utf8')) : { version: 1, images: {} };
  mkdirSync(IMAGE_DIR, { recursive: true });
  let spent = 0;
  let mismatches = 0;

  for (const pick of picks.slice(0, limit)) {
    const ad = ads.find((a) => a.creative_id === pick.creative_id)!;
    const file = path.join(IMAGE_DIR, `${ad.creative_id}.png`);
    const prompt = promptFor(ad, ads, ctx);
    if (!prompt) {
      mismatches++;
      console.log(`  skip ${ad.creative_id}: rebuilt pack doesn't match its pack_fingerprint`);
      continue;
    }
    const label = `${pick.rank ? `#${pick.rank} ` : ''}${ad.creative_id} (reward ${(pick.mean * 1e4).toFixed(1)}e-4, n=${pick.n})`;
    const old = sidecar.images[ad.creative_id];
    const entry = (cost: number, model: string): SidecarEntry => ({
      file: path.relative(process.cwd(), file),
      run_id: runId,
      segment_id: ad.segment_id,
      arm_id: ad.arm_id,
      ...(old?.run_id === runId ? { round0: old.round0, winner: old.winner } : {}),
      ...(command === 'round0'
        ? { round0: { rank: pick.rank!, mean_reward: pick.mean, impressions: pick.n } }
        : { winner: { mean_reward: pick.mean, impressions: pick.n, cpo_usd: pick.cpo, control_cpo_usd: pick.control_cpo } }),
      prompt,
      model,
      quality: QUALITY,
      size: `${SIZE.width}x${SIZE.height}`,
      cost_cents: cost,
      created_at: old?.created_at ?? new Date().toISOString(),
    });
    if (existsSync(file) && !has('force')) {
      sidecar.images[ad.creative_id] = entry(old?.cost_cents ?? 0, old?.model ?? provider.model);
      console.log(`  have ${label}`);
      continue;
    }
    if (has('dry')) {
      console.log(`  would render ${label}, ~${unit}¢\n    ${prompt.slice(0, 300)}…`);
      spent += unit;
      continue;
    }
    if (spent + unit > maxCents) {
      console.log(`  stop: the next image would pass --max-usd ${(maxCents / 100).toFixed(2)}`);
      break;
    }
    const result = await provider.generate({ prompt, ...SIZE, quality: QUALITY, signal: AbortSignal.timeout(180_000) });
    writeFileSync(file, result.imageBuffer);
    spent += unit;
    sidecar.images[ad.creative_id] = entry(unit, result.model);
    writeFileSync(SIDECAR, `${JSON.stringify(sidecar, null, 2)}\n`);
    console.log(`  rendered ${label} → ${path.relative(process.cwd(), file)}`);
  }
  if (!has('dry')) writeFileSync(SIDECAR, `${JSON.stringify(sidecar, null, 2)}\n`);
  console.log(`[images] ${has('dry') ? 'estimated' : 'spent'} about $${(spent / 100).toFixed(2)}; ${mismatches} fingerprint mismatches`);
  return mismatches ? 1 : 0;
}

type Recipe = { angle: string; hook: string };
type Context = { rows: BrandContextRow[]; brandProfileId: string; brandName: string; recipes: Map<string, Recipe> };

// The pack A5 compiled for this ad, rebuilt without copy calls: one brief per (segment, angle),
// whose hooks are the recipes A5 wrote together in the same round and run (ids share the
// cr_g<round>[_<run>] tag). The spec's candidate count is the number of those hooks; if the
// fingerprint still differs, other counts are tried (compiling is deterministic and free).
// Null when nothing matches the creative's pack_fingerprint.
function promptFor(ad: Ad & Record<string, string>, ads: readonly (Ad & Record<string, string>)[], ctx: Context): string | null {
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
    return `${renderImagePrompt(pack).prompt} This ad's visual: ${ad.visual_description}. Leave out any words, logos or text overlays.`;
  }
  return null;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[images] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

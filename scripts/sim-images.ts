import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderAdImages, type ImageMode } from '@/lib/adlab/ad-images';
import { getBrandKit, kitImageDataUrl, sniffImage } from '@/lib/adlab/brand-kit';
import { connectSpacetime } from '@/lib/adlab/spacetime-http';
import { serviceSupabase } from '@/lib/adlab/supabase';

/*
 * B: images for the demo's ads, display only (the sim stays text-only: Jev takes no images).
 *
 *   npm run sim:images -- round0 --run <run_id> [--top 15] [--dry] [--limit N] [--max-usd 2] [--force]
 *       the top round-0 ads by reward in the run's warm-up
 *   npm run sim:images -- winners --run <run_id> [--dry] [--limit N] [--max-usd 2] [--force]
 *       per segment, the winning recipe's best ad at the end of the run
 *
 *   --reference <png|jpg|webp>  render with this product photo; default: the brand kit's photo
 *                               (SpacetimeDB brand_kit, data/brand-kit/), if there is one
 *   --no-reference              render without a product photo (unbranded packaging)
 *
 * The work is lib/adlab/ad-images.ts, shared with the Copywriter's POST /api/agent/creatives/images.
 */

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(`--${name}`);

async function reference(spacetime: Awaited<ReturnType<typeof connectSpacetime>>) {
  if (has('no-reference')) return null;
  const file = flag('reference');
  if (file) {
    const bytes = readFileSync(file);
    const ext = sniffImage(bytes);
    if (!ext) throw new Error(`--reference ${file} is not a PNG, JPEG or WebP`);
    const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return { dataUrl: `data:${type};base64,${bytes.toString('base64')}`, sha: createHash('sha256').update(bytes).digest('hex') };
  }
  const kit = await getBrandKit(spacetime).catch(() => null);
  const dataUrl = kit ? await kitImageDataUrl(kit) : null;
  return kit && dataUrl ? { dataUrl, sha: kit.image_sha } : null;
}

async function main(): Promise<number> {
  if (command !== 'round0' && command !== 'winners') {
    console.error(
      'usage: npm run sim:images -- round0|winners --run <run_id> [--top 15] [--dry] [--limit N] [--max-usd 2] [--force] [--reference <photo> | --no-reference]',
    );
    return 2;
  }
  const runId = flag('run');
  if (!runId) throw new Error('--run <run_id> is required');
  const spacetime = await connectSpacetime();
  const ref = await reference(spacetime);
  console.log(`[images] product photo: ${ref ? (flag('reference') ?? 'the brand kit') : 'none (unbranded packaging)'}`);
  const result = await renderAdImages({
    spacetime,
    db: serviceSupabase(),
    runId,
    mode: command as ImageMode,
    top: Number(flag('top') ?? 15),
    ...(flag('limit') ? { limit: Number(flag('limit')) } : {}),
    maxUsd: Number(flag('max-usd') ?? 2),
    dry: has('dry'),
    force: has('force'),
    reference: ref,
    log: (line) => console.log(line),
  });
  return result.mismatches || result.images.some((i) => i.status === 'failed') ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[images] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

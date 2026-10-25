import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Serves the demo's ad images (written by `npm run sim:images` to data/ad-images/, git-ignored).
// Only plain creative ids are accepted, so no path can leave that folder.
const IMAGE_DIR = path.resolve('data/ad-images');
const ID = /^[a-z0-9_]{1,160}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return new Response('not found', { status: 404 });
  try {
    const png = await readFile(path.join(IMAGE_DIR, `${id}.png`));
    return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

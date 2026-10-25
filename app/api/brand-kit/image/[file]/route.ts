import { readKitImage } from '@/lib/adlab/brand-kit';

// Serves the brand kit's product photo from data/brand-kit/ (git-ignored). readKitImage accepts
// only <12 hex>.png|jpg|webp names, so no path can leave that folder.
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const image = await readKitImage(file);
  if (!image) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(image.bytes), {
    headers: { 'Content-Type': image.contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}

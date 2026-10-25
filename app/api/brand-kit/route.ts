import { ApiError, handle, requireRunsAllowed } from '@/app/api/agent/_lib/http';
import { getSpacetime, getSupabase } from '@/lib/adlab/agent-runtime';
import { BrandKitInputError, MAX_IMAGE_BYTES, brandKitStatus, matchProfile, onFileFor, saveBrandKit } from '@/lib/adlab/brand-kit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The onboarding step (/start). GET: the kit and, for an onboarded brand, what's on file.
// POST (multipart: url, image): saves the photo and the kit row.
export const GET = handle(async () => {
  const kit = await brandKitStatus(await getSpacetime());
  const profile = kit.brand_url ? await matchProfile(getSupabase(), kit.brand_url) : null;
  return { kit, on_file: profile ? await onFileFor(getSupabase(), profile) : null };
});

export const POST = handle(async (req) => {
  requireRunsAllowed();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError('bad_request', 'send multipart form data with url and image');
  }
  const url = form.get('url');
  const image = form.get('image');
  if (typeof url !== 'string' || url.trim() === '') throw new ApiError('bad_request', 'url is required');
  if (!(image instanceof File)) throw new ApiError('bad_request', 'image is required');
  if (image.size > MAX_IMAGE_BYTES) throw new ApiError('bad_request', `the product image is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  try {
    const saved = await saveBrandKit({ spacetime: await getSpacetime(), db: getSupabase() }, { url, bytes: new Uint8Array(await image.arrayBuffer()) });
    return { kit: await brandKitStatus(await getSpacetime()), on_file: saved.on_file };
  } catch (err) {
    if (err instanceof BrandKitInputError) throw new ApiError('bad_request', err.message);
    throw err;
  }
});

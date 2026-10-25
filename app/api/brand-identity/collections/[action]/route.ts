import { fail, ok, PageError } from '@/lib/adlab/pages/http';

// Saved collections are not part of Ad Lab: the reads answer empty so the
// pages render, and every write is a 501 the Save button toasts.
export async function POST(_req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action === 'list') return ok([]);
  if (action === 'membership') return ok({});
  return fail(new PageError(501, 'NOT_IMPLEMENTED', 'Saved collections are not part of Ad Lab'));
}

import { z } from 'zod';
import { readLearnings } from '@/lib/adlab/agent-api';
import { getSpacetime } from '@/lib/adlab/agent-runtime';
import { handle, parseQuery } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  run_id: z.string().optional(),
  ids: z
    .string()
    .optional()
    .transform((ids) => (ids ? ids.split(',').map((id) => id.trim()).filter(Boolean) : undefined)),
});

export const GET = handle(async (req) => {
  const query = parseQuery(req, Query);
  return { learnings: await readLearnings(await getSpacetime(), query) };
});

import { z } from 'zod';
import { getSpacetime, getSupabase } from '@/lib/adlab/agent-runtime';
import { brandSummary } from '@/lib/adlab/agent-summaries';
import { handle, parseQuery } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({ fresh: z.string().optional() });

// Cached for 5 minutes; ?fresh=1 recomputes.
export const GET = handle(async (req) => {
  const { fresh } = parseQuery(req, Query);
  return brandSummary({ spacetime: await getSpacetime(), db: getSupabase() }, { fresh: fresh === '1' });
});

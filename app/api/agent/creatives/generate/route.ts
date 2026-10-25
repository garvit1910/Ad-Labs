import { z } from 'zod';
import { getSpacetime, getSupabase } from '@/lib/adlab/agent-runtime';
import { generateForCopywriter } from '@/lib/adlab/copywriter';
import { mapErrors } from '../../_lib/errors';
import { handle, parseJson, requireRunsAllowed } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const Body = z.object({
  task_id: z.string().regex(/^tsk_[a-z0-9_]+$/),
  learning_ids: z.array(z.string()).max(50).optional(),
  next_round: z.enum(['queue', 'skip']).optional(),
});

// Synchronous, one in-flight call per task. An empty body is a fast 400 (the agents warm the route with it).
// claim_lost (409) when another worker holds the task; generate_failed (502) on any other throw, with the
// task still claimed by the Copywriter, which retries and then calls /creatives/fail.
export const POST = handle(async (req) => {
  const body = await parseJson(req, Body);
  requireRunsAllowed();
  const spacetime = await getSpacetime();
  return mapErrors(() => generateForCopywriter(body, { spacetime, db: getSupabase() }));
});

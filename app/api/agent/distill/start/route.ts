import { z } from 'zod';
import { ApiError, handle, parseJson } from '@/app/api/agent/_lib/http';
import { agentMode, getSupabase } from '@/lib/adlab/agent-runtime';
import { distillFreshness, supabaseErrorMessage } from '@/lib/adlab/ingest-refresh';
import { PARTIES } from '@/spacetime/src/agent_rules';

// POST /api/agent/distill/start (docs/AGENT_API.md "Scout"): a freshness report only. It never
// enqueues tonight: distill rewrites the persona facts every A5 task reads.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ requested_by: z.enum(PARTIES), force: z.boolean().default(false) });

export const POST = handle(async (req) => {
  const body = await parseJson(req, Body);
  try {
    return await distillFreshness(getSupabase(), { force: body.force, mode: agentMode() });
  } catch (err) {
    const upstream = supabaseErrorMessage(err);
    if (upstream) throw new ApiError('upstream', upstream);
    throw err;
  }
});

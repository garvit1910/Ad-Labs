import { z } from 'zod';
import { ApiError, handle, parseJson, requireRunsAllowed } from '@/app/api/agent/_lib/http';
import { agentMode, getSpacetime, getSupabase } from '@/lib/adlab/agent-runtime';
import { REFRESH_LIMITS, RefreshRequestError, refresh, supabaseErrorMessage } from '@/lib/adlab/ingest-refresh';
import { PARTIES } from '@/spacetime/src/agent_rules';

// POST /api/agent/ingest/refresh (docs/AGENT_API.md "Scout"): dry plans only; execute writes
// ingest_job rows (skipped in test mode, pending after a real enqueue in live mode).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  requested_by: z.enum(PARTIES),
  dry: z.boolean().default(false),
  targets: z
    .array(z.object({ kind: z.enum(['page', 'source']), ref_id: z.string().trim().min(1).max(64) }))
    .max(REFRESH_LIMITS.pages.max + REFRESH_LIMITS.sources.max)
    .optional(),
  pages: z.number().int().min(0).max(REFRESH_LIMITS.pages.max).default(REFRESH_LIMITS.pages.default),
  sources: z.number().int().min(0).max(REFRESH_LIMITS.sources.max).default(REFRESH_LIMITS.sources.default),
});

export const POST = handle(async (req) => {
  const body = await parseJson(req, Body);
  if (!body.dry) requireRunsAllowed();
  try {
    return await refresh(getSupabase(), getSpacetime, { ...body, mode: agentMode() });
  } catch (err) {
    if (err instanceof RefreshRequestError) throw new ApiError('bad_request', err.message);
    const upstream = supabaseErrorMessage(err);
    if (upstream) throw new ApiError('upstream', upstream);
    throw err;
  }
});

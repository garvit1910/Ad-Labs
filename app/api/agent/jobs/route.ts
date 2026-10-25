import { z } from 'zod';
import { ApiError, handle, parseQuery } from '@/app/api/agent/_lib/http';
import { getSpacetime, getSupabase } from '@/lib/adlab/agent-runtime';
import { jobsStatus, supabaseErrorMessage } from '@/lib/adlab/ingest-refresh';
import { JOB_ID_RE } from '@/spacetime/src/agent_rules';

// GET /api/agent/jobs?ids=a,b (docs/AGENT_API.md "Scout"): at most 20 job ids, job_queue merged
// with ingest_job; cancelled reads skipped, dry ids come from ingest_job alone.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_IDS = 20;

const Query = z.object({
  ids: z
    .string()
    .transform((s) => [...new Set(s.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))])
    .pipe(z.array(z.string().regex(JOB_ID_RE, 'each id must be a job uuid')).min(1, 'give at least one id').max(MAX_IDS, `at most ${MAX_IDS} ids`)),
});

export const GET = handle(async (req) => {
  const { ids } = parseQuery(req, Query);
  try {
    return await jobsStatus(getSupabase(), getSpacetime, ids);
  } catch (err) {
    const upstream = supabaseErrorMessage(err);
    if (upstream) throw new ApiError('upstream', upstream);
    throw err;
  }
});

import { z } from 'zod';
import { getSpacetime, getSupabase } from '@/lib/adlab/agent-runtime';
import { contractCheck } from '@/lib/adlab/agent-summaries';
import { ApiError, handle, parseJson } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ mode: z.enum(['check', 'rebuild']).default('check') });

// Check only: it reads A4's rows and round 0 and writes nothing.
export const POST = handle(async (req) => {
  const { mode } = await parseJson(req, Body);
  if (mode === 'rebuild') throw new ApiError('not_supported', 'rebuild is CLI-only tonight: npm run a4:rows -- --keep-arms');
  return contractCheck({ spacetime: await getSpacetime(), db: getSupabase() });
});

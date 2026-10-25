import { z } from 'zod';
import { getSpacetime } from '@/lib/adlab/agent-runtime';
import { failForCopywriter } from '@/lib/adlab/copywriter';
import { handle, parseJson, requireRunsAllowed } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ task_id: z.string().min(1), error: z.string().min(1) });

// Fails the task only while the Copywriter still holds it ({failed: false} otherwise).
export const POST = handle(async (req) => {
  const body = await parseJson(req, Body);
  requireRunsAllowed();
  return failForCopywriter(await getSpacetime(), body.task_id, body.error);
});

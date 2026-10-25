import { z } from 'zod';
import { readTasks } from '@/lib/adlab/agent-api';
import { getSpacetime } from '@/lib/adlab/agent-runtime';
import { handle, parseQuery } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  kind: z.string().optional(),
  status: z.string().optional(),
  run_id: z.string().optional(),
  task_id: z.string().optional(),
});

export const GET = handle(async (req) => {
  const query = parseQuery(req, Query);
  return { tasks: await readTasks(await getSpacetime(), query) };
});

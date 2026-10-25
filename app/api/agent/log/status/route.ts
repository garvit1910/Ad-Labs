import { z } from 'zod';
import { setAgentStatus } from '@/lib/adlab/agent-api';
import { getSpacetime } from '@/lib/adlab/agent-runtime';
import { mapErrors } from '../../_lib/errors';
import { handle, parseJson, requireRunsAllowed } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Shapes only; current_step is clamped, then spacetime/src/agent_rules.ts decides.
const Body = z.object({
  agent_id: z.string(),
  name: z.string(),
  role: z.string(),
  address: z.string().default(''),
  status: z.string(),
  current_step: z.string().default(''),
});

export const POST = handle(async (req) => {
  const body = await parseJson(req, Body);
  requireRunsAllowed();
  const spacetime = await getSpacetime();
  await mapErrors(() => setAgentStatus(spacetime, body));
  return {};
});

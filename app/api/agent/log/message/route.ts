import { z } from 'zod';
import { logAgentMessage } from '@/lib/adlab/agent-api';
import { getSpacetime } from '@/lib/adlab/agent-runtime';
import { mapErrors } from '../../_lib/errors';
import { handle, parseJson, requireRunsAllowed } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Shapes only; the summary and payload are clamped, then spacetime/src/agent_rules.ts decides.
const Body = z.object({
  from_agent: z.string(),
  to_agent: z.string(),
  protocol: z.string(),
  kind: z.string(),
  summary: z.string(),
  payload: z.record(z.unknown()),
  run_id: z.string().optional(),
});

export const POST = handle(async (req) => {
  const body = await parseJson(req, Body);
  requireRunsAllowed();
  const spacetime = await getSpacetime();
  return { message_id: await mapErrors(() => logAgentMessage(spacetime, body)) };
});

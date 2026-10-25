import { z } from 'zod';
import { getSpacetime, getSupabase } from '@/lib/adlab/agent-runtime';
import { startRun } from '@/lib/adlab/runs';
import { isParty } from '@/spacetime/src/agent_rules';
import { handle, parseJson, requireRunsAllowed } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// startRun checks the ranges, the target, the run slot and round 0 itself (lib/adlab/runs.ts).
const Body = z.object({
  run_id: z.string(),
  rounds_planned: z.number().optional(),
  population: z.number().optional(),
  seed: z.number().optional(),
  requested_by: z.string().refine(isParty, 'requested_by must be an agent id or user'),
});

export const POST = handle(async (req) => {
  const body = await parseJson(req, Body);
  requireRunsAllowed();
  return startRun(
    await getSpacetime(),
    { runId: body.run_id, roundsPlanned: body.rounds_planned, population: body.population, seed: body.seed, requestedBy: body.requested_by },
    { db: getSupabase() },
  );
});

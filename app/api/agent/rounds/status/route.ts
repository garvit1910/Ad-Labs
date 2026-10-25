import { z } from 'zod';
import { readRounds, readRun, readTasks } from '@/lib/adlab/agent-api';
import { getSpacetime } from '@/lib/adlab/agent-runtime';
import { derivePhase } from '@/lib/adlab/round-cards';
import { handle, parseQuery } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({ run_id: z.string().min(1) });

export const GET = handle(async (req) => {
  const { run_id } = parseQuery(req, Query);
  const spacetime = await getSpacetime();
  const [run, rounds, tasks] = await Promise.all([readRun(spacetime, run_id), readRounds(spacetime, run_id), readTasks(spacetime, { run_id })]);
  return {
    run,
    rounds: rounds.map(({ round, status, started_at, finished_at }) => ({ round, status, started_at, finished_at })),
    tasks,
    ...derivePhase(run, rounds, tasks),
  };
});

import { z } from 'zod';
import { readArms, readLearningRows, readRounds, readRun, readSegments } from '@/lib/adlab/agent-api';
import { getSpacetime } from '@/lib/adlab/agent-runtime';
import { roundSummaryCard } from '@/lib/adlab/round-cards';
import { ApiError, handle, parseQuery } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  run_id: z.string().min(1),
  round: z.coerce.number().int().min(0).optional(),
});

// Default: the latest done round. A round that isn't done is 409 not_ready.
export const GET = handle(async (req) => {
  const { run_id, round } = parseQuery(req, Query);
  const spacetime = await getSpacetime();
  const [run, rounds, arms, segments, learnings] = await Promise.all([
    readRun(spacetime, run_id),
    readRounds(spacetime, run_id),
    readArms(spacetime),
    readSegments(spacetime),
    readLearningRows(spacetime, run_id),
  ]);
  const row = round === undefined ? rounds.filter((r) => r.status === 'done').at(-1) : rounds.find((r) => r.round === round);
  if (!row || row.status !== 'done') {
    throw new ApiError('not_ready', round === undefined ? `run ${run_id} has no finished round yet` : `round ${round} of ${run_id} is ${row?.status ?? 'not started'}`);
  }
  return roundSummaryCard(row, { arms, segments, learnings, roundsPlanned: run?.rounds_planned ?? 0 });
});

import { z } from 'zod';
import { readArms, readGeneratedCreatives, readLearningRows, readRounds, readSegments } from '@/lib/adlab/agent-api';
import { getSpacetime } from '@/lib/adlab/agent-runtime';
import { winnersCard } from '@/lib/adlab/round-cards';
import { handle, parseQuery } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({ run_id: z.string().min(1) });

// A live winner learning per segment, else the latest done round's leading recipe.
export const GET = handle(async (req) => {
  const { run_id } = parseQuery(req, Query);
  const spacetime = await getSpacetime();
  const [rounds, arms, segments, learnings, creatives] = await Promise.all([
    readRounds(spacetime, run_id),
    readArms(spacetime),
    readSegments(spacetime),
    readLearningRows(spacetime, run_id),
    readGeneratedCreatives(spacetime),
  ]);
  const latestDone = rounds.filter((r) => r.status === 'done').at(-1) ?? null;
  return { winners: winnersCard({ runId: run_id, learnings, arms, segments, creatives, latestDone }) };
});

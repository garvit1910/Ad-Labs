import { z } from 'zod';
import { buildCompetitorDashboard } from '@/lib/adlab/pages/ads';
import { orgBody, pageHandler, pagesDb } from '@/lib/adlab/pages/http';

const schema = orgBody.extend({
  /** Omitted: all competitors. */
  competitorId: z.string().uuid().optional(),
  platform: z.enum(['meta', 'google', 'all']).default('all'),
});

export const POST = pageHandler({
  schema,
  live: (body) => buildCompetitorDashboard(pagesDb(), { competitorId: body.competitorId, platform: body.platform }),
});

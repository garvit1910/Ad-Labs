import { listCompetitorsWithCounts } from '@/lib/adlab/pages/ads';
import { orgBody, pageHandler, pagesDb } from '@/lib/adlab/pages/http';

// The 7 tracked competitors (Magic Spoon's own page excluded) with per-competitor counts.
export const POST = pageHandler({ schema: orgBody, live: () => listCompetitorsWithCounts(pagesDb()) });

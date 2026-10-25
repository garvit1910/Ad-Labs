import { z } from 'zod';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { assembleSynthesis, loadFactViews, skippedSynthesis } from '@/lib/adlab/pages/facts';
import { pageHandler, pagesDb, profileBody, requireProfile } from '@/lib/adlab/pages/http';

// Chapter 02's narrative, assembled deterministically from live brand facts
// (no LLM). The [organizationId] segment is ignored: Ad Lab has one org.
export const dynamic = 'force-dynamic';

async function build(brandProfileId: string) {
  const db = pagesDb();
  const profile = await requireProfile(db, brandProfileId);
  const facts = await loadFactViews(db, profile.id);
  const scope = { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id, brandName: profile.brand_name };
  return { facts, scope, synthesis: assembleSynthesis(facts, scope) };
}

export const GET = pageHandler({
  schema: profileBody,
  live: async (body) => {
    const { synthesis } = await build(body.brandProfileId);
    return { synthesis, staleness: { stale: false, reason: synthesis ? 'fresh' : 'no_synthesis' } };
  },
});

export const POST = pageHandler({
  schema: profileBody.extend({ force: z.boolean().optional() }),
  live: async (body) => {
    const { facts, scope, synthesis } = await build(body.brandProfileId);
    return synthesis ?? skippedSynthesis(scope, facts);
  },
});

import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { loadFactViews } from '@/lib/adlab/pages/facts';
import { dbError, pageHandler, pagesDb, profileBody, requireProfile } from '@/lib/adlab/pages/http';

// Every live brand fact (evidence inline) plus the pending-suggestion count per fact.
export const POST = pageHandler({
  schema: profileBody,
  live: async (body) => {
    const db = pagesDb();
    const profile = await requireProfile(db, body.brandProfileId);
    const facts = await loadFactViews(db, profile.id);
    const { data: suggestions, error } = await db
      .from('brand_fact_suggestions')
      .select('fact_id')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', profile.id)
      .eq('status', 'proposed');
    if (error) throw dbError('Failed to load fact suggestions', error);
    const pendingSuggestionsByFactId: Record<string, number> = {};
    for (const row of suggestions ?? []) {
      const key = String(row.fact_id);
      pendingSuggestionsByFactId[key] = (pendingSuggestionsByFactId[key] ?? 0) + 1;
    }
    return { facts, pendingSuggestionsByFactId };
  },
});

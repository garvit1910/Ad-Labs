import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { dbError, loadProfiles, orgBody, pageHandler, pagesDb } from '@/lib/adlab/pages/http';

// Every brand profile (newest first) with its kept-mention count (relevance <> irrelevant).
export const POST = pageHandler({
  schema: orgBody,
  live: async () => {
    const db = pagesDb();
    const profiles = await loadProfiles(db);
    const keptCounts: Record<string, number> = {};
    await Promise.all(
      profiles.map(async (profile) => {
        const { count, error } = await db
          .from('brand_mentions')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', ADLAB_ORG_ID)
          .eq('brand_profile_id', profile.id)
          .neq('relevance', 'irrelevant');
        if (error) throw dbError('Failed to count mentions', error);
        keptCounts[profile.id] = count ?? 0;
      })
    );
    return { profiles, keptCounts };
  },
});

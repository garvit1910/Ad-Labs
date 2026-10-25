import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { dbError, findProfile, pageHandler, pagesDb, profileBody } from '@/lib/adlab/pages/http';
import { LIVE_SOURCE_TYPES } from '@/lib/brand-presence/types';

// The brand's listening sources plus a kept-mention count per live source (keyed by source id).
export const POST = pageHandler({
  schema: profileBody,
  live: async (body) => {
    const db = pagesDb();
    const profile = await findProfile(db, body.brandProfileId);
    if (!profile) return { sources: [], mentionCounts: {} };

    const { data: sources, error } = await db
      .from('brand_presence_sources')
      .select('*')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', profile.id)
      .order('created_at', { ascending: true });
    if (error) throw dbError('Failed to list sources', error);

    const mentionCounts: Record<string, number> = {};
    await Promise.all(
      (sources ?? [])
        .filter((source) => (LIVE_SOURCE_TYPES as readonly string[]).includes(String(source.source_type)))
        .map(async (source) => {
          const { count, error: countError } = await db
            .from('brand_mentions')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', ADLAB_ORG_ID)
            .eq('brand_profile_id', profile.id)
            .eq('source_id', source.id)
            .neq('relevance', 'irrelevant');
          if (countError) throw dbError('Failed to count mentions', countError);
          mentionCounts[String(source.id)] = count ?? 0;
        })
    );
    return { sources: sources ?? [], mentionCounts };
  },
});

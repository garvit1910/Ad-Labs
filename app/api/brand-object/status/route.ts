import type { SupabaseClient } from '@supabase/supabase-js';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { dbError, pageHandler, pagesDb, profileBody, requireProfile } from '@/lib/adlab/pages/http';
import { getAwaitingConfirm } from '@/lib/brand-presence/awaiting-confirm';
import type { SourceMeta } from '@/lib/brand-presence/types';
import { ADLIB_SYNC_COMPETITOR_JOB_TYPE } from '@/services/job-processor/ad-library/types';
import { getBrandObjectState } from '@/services/job-processor/brand-object/state';
import { BRAND_OBJECT_JOB_TYPES } from '@/services/job-processor/brand-object/types';
import { BRAND_PRESENCE_JOB_TYPES } from '@/services/job-processor/brand-presence/types';

// Brand Object status (Adcero's brand-object/status route): the state row, the
// brand's active build jobs and the cross-family progress the build card reads.

async function loadBuildProgress(db: SupabaseClient, brandProfileId: string) {
  const [tagged, adlibJobs, mentions, sources, presenceJobs] = await Promise.all([
    db
      .from('tracked_competitors')
      .select('id, last_synced_at')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', brandProfileId)
      .eq('status', 'active')
      // Magic Spoon's own page is tracked too (is_brand_self); it isn't a competitor.
      .eq('is_brand_self', false),
    db
      .from('job_queue')
      .select('dedupe_key')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('type', ADLIB_SYNC_COMPETITOR_JOB_TYPE)
      .in('status', ['pending', 'processing']),
    db
      .from('brand_mentions')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', brandProfileId)
      .neq('relevance', 'irrelevant'),
    db
      .from('brand_presence_sources')
      .select('id, source_type, status, meta')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', brandProfileId),
    db
      .from('job_queue')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('payload->>brandProfileId', brandProfileId)
      .in('type', [...BRAND_PRESENCE_JOB_TYPES])
      .in('status', ['pending', 'processing']),
  ]);
  if (tagged.error) throw dbError('Failed to load tagged competitors', tagged.error);
  if (adlibJobs.error) throw dbError('Failed to load sync jobs', adlibJobs.error);
  if (mentions.error) throw dbError('Failed to count mentions', mentions.error);
  if (sources.error) throw dbError('Failed to load sources', sources.error);
  if (presenceJobs.error) throw dbError('Failed to count listening jobs', presenceJobs.error);

  const taggedRows = tagged.data ?? [];
  const activeSyncKeys = new Set((adlibJobs.data ?? []).map((row) => String(row.dedupe_key ?? '')));
  return {
    competitors: {
      tagged: taggedRows.length,
      synced: taggedRows.filter((row) => row.last_synced_at != null).length,
      syncing: taggedRows.filter((row) => activeSyncKeys.has(`adlib_sync:${row.id}`)).length,
    },
    listening: {
      keptMentions: mentions.count ?? 0,
      activeJobs: presenceJobs.count ?? 0,
      // Sources parked on the founder-confirm gate are not working.
      activeSources: (sources.data ?? []).filter(
        (row) =>
          (row.status === 'pending' || row.status === 'running') &&
          !getAwaitingConfirm(String(row.source_type), row.meta as SourceMeta | null)
      ).length,
    },
  };
}

export const POST = pageHandler({
  schema: profileBody,
  live: async (body) => {
    const db = pagesDb();
    const profile = await requireProfile(db, body.brandProfileId);
    const [state, jobs, progress] = await Promise.all([
      getBrandObjectState(db, ADLAB_ORG_ID, profile.id),
      db
        .from('job_queue')
        .select('type, status')
        .eq('organization_id', ADLAB_ORG_ID)
        .in('type', [...BRAND_OBJECT_JOB_TYPES])
        .in('status', ['pending', 'processing'])
        .like('dedupe_key', `%${profile.id}`),
      loadBuildProgress(db, profile.id),
    ]);
    if (jobs.error) throw dbError('Failed to load brand object jobs', jobs.error);
    return {
      state: state ? { status: state.status, completeness: state.completeness, cost: state.cost } : null,
      activeJobs: (jobs.data ?? []).map((job) => ({ type: job.type, status: job.status })),
      progress,
    };
  },
});

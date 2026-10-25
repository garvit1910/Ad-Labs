import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { dbError, loadProfiles, orgBody, pageHandler, pagesDb } from '@/lib/adlab/pages/http';
import { BRAND_OBJECT_JOB_TYPES } from '@/services/job-processor/brand-object/types';

// One row per own brand profile with its Brand Object health (Adcero's portfolio route).
// liveFactCount uses the same live-fact predicate as brand-object/facts.
export const POST = pageHandler({
  schema: orgBody,
  live: async () => {
    const db = pagesDb();
    const profiles = (await loadProfiles(db)).filter((p) => p.presence_role !== 'competitor');
    const profileIds = profiles.map((p) => p.id);
    const empty = Promise.resolve({ data: [] as Record<string, unknown>[], error: null });

    const [statesRes, factsRes, jobsRes, competitorsRes] = await Promise.all([
      profileIds.length
        ? db
            .from('brand_object_state')
            .select('brand_profile_id, status, completeness')
            .eq('organization_id', ADLAB_ORG_ID)
            .in('brand_profile_id', profileIds)
        : empty,
      profileIds.length
        ? db
            .from('brand_facts')
            .select('brand_profile_id')
            .eq('organization_id', ADLAB_ORG_ID)
            .is('valid_to', null) // live-fact predicate: the same two filters as loadFactViews
            .neq('status', 'rejected')
            .limit(10000)
        : empty,
      db
        .from('job_queue')
        .select('type, dedupe_key')
        .eq('organization_id', ADLAB_ORG_ID)
        .in('type', [...BRAND_OBJECT_JOB_TYPES])
        .in('status', ['pending', 'processing']),
      db.from('tracked_competitors').select('brand_profile_id').eq('organization_id', ADLAB_ORG_ID).eq('status', 'active').eq('is_brand_self', false),
    ]);
    if (statesRes.error) throw dbError('Failed to load brand object state', statesRes.error);
    if (factsRes.error) throw dbError('Failed to count brand facts', factsRes.error);
    if (jobsRes.error) throw dbError('Failed to load brand object jobs', jobsRes.error);
    if (competitorsRes.error) throw dbError('Failed to load competitors', competitorsRes.error);

    const stateByProfile = new Map((statesRes.data ?? []).map((row) => [String(row.brand_profile_id), row]));
    const factCounts = new Map<string, number>();
    for (const row of factsRes.data ?? []) {
      const id = String(row.brand_profile_id);
      factCounts.set(id, (factCounts.get(id) ?? 0) + 1);
    }
    const jobsByProfile = new Map<string, string[]>();
    for (const job of jobsRes.data ?? []) {
      const dedupe = String(job.dedupe_key ?? '');
      const owner = profileIds.find((id) => dedupe.endsWith(id));
      if (owner) jobsByProfile.set(owner, [...(jobsByProfile.get(owner) ?? []), String(job.type)]);
    }
    const taggedCounts = new Map<string, number>();
    let orgCompetitorCount = 0;
    for (const row of competitorsRes.data ?? []) {
      orgCompetitorCount += 1;
      if (!row.brand_profile_id) continue;
      const id = String(row.brand_profile_id);
      taggedCounts.set(id, (taggedCounts.get(id) ?? 0) + 1);
    }

    return {
      orgCompetitorCount,
      profiles: profiles.map((profile) => {
        const state = stateByProfile.get(profile.id);
        const completeness = (state?.completeness ?? null) as { overall?: number } | null;
        return {
          profileId: profile.id,
          brandName: profile.brand_name,
          websiteUrl: (profile.website_url as string | null | undefined) ?? null,
          profileStatus: profile.status,
          boStatus: (state?.status as string | undefined) ?? null,
          completenessOverall: typeof completeness?.overall === 'number' ? completeness.overall : null,
          liveFactCount: factCounts.get(profile.id) ?? 0,
          activeJobTypes: jobsByProfile.get(profile.id) ?? [],
          taggedCompetitorCount: taggedCounts.get(profile.id) ?? 0,
        };
      }),
    };
  },
});

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { dbError, findProfile, PageError, pageHandler, pagesDb, profileBody } from '@/lib/adlab/pages/http';
import { getAwaitingConfirm } from '@/lib/brand-presence/awaiting-confirm';
import { brandPresenceStatusSchema } from '@/lib/brand-presence/client-schemas';
import type { SourceMeta } from '@/lib/brand-presence/types';
import { BRAND_PRESENCE_JOB_TYPES } from '@/services/job-processor/brand-presence/types';

// Listening pipeline status (Adcero's brand-presence/status route): per-source
// status, mention counts by scope and relevance, and the brand's active jobs.
// The answer is parsed with the client's zod schema so drift fails here.

async function loadSources(db: SupabaseClient, brandProfileId: string) {
  const { data, error } = await db
    .from('brand_presence_sources')
    .select('id, source_type, uri, label, status, last_synced_at, meta')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('brand_profile_id', brandProfileId);
  if (error) throw dbError('Failed to load source statuses', error);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    source_type: String(row.source_type),
    uri: String(row.uri ?? ''),
    label: (row.label as string | null) ?? null,
    status: String(row.status),
    last_synced_at: (row.last_synced_at as string | null) ?? null,
    awaitingConfirm: getAwaitingConfirm(String(row.source_type), row.meta as SourceMeta | null),
  }));
}

async function loadCounts(db: SupabaseClient, brandProfileId: string) {
  const countWhere = async (filters: Record<string, string>, notRelevance?: string): Promise<number> => {
    let query = db
      .from('brand_mentions')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', brandProfileId);
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    if (notRelevance) query = query.neq('relevance', notRelevance);
    const { count, error } = await query;
    if (error) throw dbError('Failed to count mentions', error);
    return count ?? 0;
  };
  const [total, kept, brand, brandKept, competitor, competitorKept, category, categoryKept, relevant, irrelevant, pending, topSubreddits] =
    await Promise.all([
      countWhere({}),
      countWhere({}, 'irrelevant'),
      countWhere({ scope: 'brand' }),
      countWhere({ scope: 'brand' }, 'irrelevant'),
      countWhere({ scope: 'competitor' }),
      countWhere({ scope: 'competitor' }, 'irrelevant'),
      countWhere({ scope: 'category' }),
      countWhere({ scope: 'category' }, 'irrelevant'),
      countWhere({ relevance: 'relevant' }),
      countWhere({ relevance: 'irrelevant' }),
      countWhere({ relevance: 'pending' }),
      loadTopSubreddits(db, brandProfileId),
    ]);
  return { total, kept, brand, brandKept, competitor, competitorKept, category, categoryKept, relevant, irrelevant, pending, topSubreddits };
}

async function loadTopSubreddits(db: SupabaseClient, brandProfileId: string) {
  const { data, error } = await db
    .from('brand_mentions')
    .select('subreddit')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('brand_profile_id', brandProfileId)
    .neq('relevance', 'irrelevant')
    .not('subreddit', 'is', null)
    .limit(5000);
  if (error) throw dbError('Failed to load subreddit counts', error);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const subreddit = String(row.subreddit);
    counts.set(subreddit, (counts.get(subreddit) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([subreddit, count]) => ({ subreddit, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

async function loadActiveJobs(db: SupabaseClient, brandProfileId: string) {
  const { data, error } = await db
    .from('job_queue')
    .select('id, type, status, created_at')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('payload->>brandProfileId', brandProfileId)
    .in('type', [...BRAND_PRESENCE_JOB_TYPES])
    .in('status', ['pending', 'processing'])
    .order('created_at', { ascending: true });
  if (error) throw dbError('Failed to load active jobs', error);
  return (data ?? []).map((row) => ({ ...row, id: String(row.id) }));
}

/** A server-side shape drift is a 500, not the client's 400. */
function checked(entity: unknown) {
  const parsed = brandPresenceStatusSchema.safeParse(entity);
  if (!parsed.success) {
    throw new PageError(500, 'SHAPE_DRIFT', `brand-presence/status failed its schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

export const POST = pageHandler({
  schema: profileBody.extend({ include: z.enum(['full', 'activity']).default('full') }),
  live: async (body) => {
    const db = pagesDb();
    const profile = await findProfile(db, body.brandProfileId);
    if (!profile) {
      return checked({ profileStatus: null, sources: [], counts: null, activeJobs: [] });
    }
    const [sources, counts, activeJobs] = await Promise.all([
      loadSources(db, profile.id),
      body.include === 'full' ? loadCounts(db, profile.id) : Promise.resolve(null),
      loadActiveJobs(db, profile.id),
    ]);
    return checked({ profileStatus: profile.status, sources, counts, activeJobs });
  },
});

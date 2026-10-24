import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type { UserActivityActor } from '@/lib/user-activity/record';
import {
  BRAND_PRESENCE_AMAZON_PRODUCTS_JOB_TYPE,
  BRAND_PRESENCE_AMAZON_REVIEWS_JOB_TYPE,
  BRAND_PRESENCE_CLUSTER_JOB_TYPE,
  BRAND_PRESENCE_DISCOVER_JOB_TYPE,
  BRAND_PRESENCE_EXTRACT_JOB_TYPE,
  BRAND_PRESENCE_GOOGLE_PLACE_JOB_TYPE,
  BRAND_PRESENCE_GOOGLE_REVIEWS_JOB_TYPE,
  BRAND_PRESENCE_RELEVANCE_JOB_TYPE,
  BRAND_PRESENCE_SCRAPE_JOB_TYPE,
  BRAND_PRESENCE_INSTAGRAM_COMMENTS_JOB_TYPE,
  BRAND_PRESENCE_INSTAGRAM_PROFILE_JOB_TYPE,
  BRAND_PRESENCE_SUBREDDITS_JOB_TYPE,
  BRAND_PRESENCE_TIKTOK_COMMENTS_JOB_TYPE,
  BRAND_PRESENCE_TIKTOK_PROFILE_JOB_TYPE,
  BRAND_PRESENCE_TRUSTPILOT_RESOLVE_JOB_TYPE,
  BRAND_PRESENCE_TRUSTPILOT_REVIEWS_JOB_TYPE,
  BRAND_PRESENCE_X_SCRAPE_JOB_TYPE,
  BRAND_PRESENCE_JOB_TYPES,
} from './types';

export async function findActiveJob(
  supabase: SupabaseClient,
  type: string,
  dedupeKey: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('job_queue')
    .select('id')
    .eq('type', type)
    .eq('dedupe_key', dedupeKey)
    .in('status', ['pending', 'processing'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id ?? null;
}

export async function findRecentCompletedJob(
  supabase: SupabaseClient,
  type: string,
  dedupeKey: string,
  withinMs: number,
): Promise<{ id: string; completedAt: string } | null> {
  const cutoff = new Date(Date.now() - withinMs).toISOString();
  const { data, error } = await supabase
    .from('job_queue')
    .select('id, completed_at')
    .eq('type', type)
    .eq('dedupe_key', dedupeKey)
    .eq('status', 'completed')
    .gte('completed_at', cutoff)
    .order('completed_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  return row?.completed_at
    ? { id: String(row.id), completedAt: String(row.completed_at) }
    : null;
}

/** Amazon review syncs fan out one dedupe key per product, so the manual
 * source-level cooldown is matched through the durable payload source id. */
export async function findRecentCompletedSourceJob(
  supabase: SupabaseClient,
  type: string,
  sourceId: string,
  withinMs: number,
): Promise<{ id: string; completedAt: string } | null> {
  const cutoff = new Date(Date.now() - withinMs).toISOString();
  const { data, error } = await supabase
    .from('job_queue')
    .select('id, completed_at')
    .eq('type', type)
    .filter('payload->>sourceId', 'eq', sourceId)
    .eq('status', 'completed')
    .gte('completed_at', cutoff)
    .order('completed_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  return row?.completed_at
    ? { id: String(row.id), completedAt: String(row.completed_at) }
    : null;
}

export async function findActiveSourceJob(
  supabase: SupabaseClient,
  type: string,
  sourceId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('job_queue')
    .select('id')
    .eq('type', type)
    .filter('payload->>sourceId', 'eq', sourceId)
    .in('status', ['pending', 'processing'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id ? String(data[0].id) : null;
}

export type BrandPresenceSyncJobTarget =
  | { kind: 'dedupe'; type: string; dedupeKey: string }
  | { kind: 'source'; type: string; sourceId: string };

/** Canonical job identity shared by manual-sync cooldown checks and enqueue. */
export function getBrandPresenceSyncJobTarget(
  sourceType: string,
  sourceId: string,
): BrandPresenceSyncJobTarget | null {
  if (sourceType.startsWith('reddit')) {
    return {
      kind: 'dedupe',
      type: BRAND_PRESENCE_SCRAPE_JOB_TYPE,
      dedupeKey: `bp_scrape:${sourceId}`,
    };
  }
  switch (sourceType) {
    case 'amazon_reviews':
      return {
        kind: 'source',
        type: BRAND_PRESENCE_AMAZON_REVIEWS_JOB_TYPE,
        sourceId,
      };
    case 'google_maps_reviews':
      return {
        kind: 'dedupe',
        type: BRAND_PRESENCE_GOOGLE_REVIEWS_JOB_TYPE,
        dedupeKey: `bp_google_reviews:${sourceId}`,
      };
    case 'x':
      return {
        kind: 'dedupe',
        type: BRAND_PRESENCE_X_SCRAPE_JOB_TYPE,
        dedupeKey: `bp_x_scrape:${sourceId}`,
      };
    case 'trustpilot':
      return {
        kind: 'dedupe',
        type: BRAND_PRESENCE_TRUSTPILOT_REVIEWS_JOB_TYPE,
        dedupeKey: `bp_tp_reviews:${sourceId}`,
      };
    case 'tiktok_comments':
      return {
        kind: 'dedupe',
        type: BRAND_PRESENCE_TIKTOK_COMMENTS_JOB_TYPE,
        dedupeKey: `bp_tiktok_comments:${sourceId}`,
      };
    case 'instagram_comments':
      return {
        kind: 'dedupe',
        type: BRAND_PRESENCE_INSTAGRAM_COMMENTS_JOB_TYPE,
        dedupeKey: `bp_instagram_comments:${sourceId}`,
      };
    default:
      return null;
  }
}

export function getBrandPresenceClusterJobTarget(brandProfileId: string): {
  type: string;
  dedupeKey: string;
} {
  return {
    type: BRAND_PRESENCE_CLUSTER_JOB_TYPE,
    dedupeKey: `bp_cluster:${brandProfileId}`,
  };
}

/** The partial unique index backing the insert-race guard (see the GA4
 * enrichment queue precedent: idx_job_queue_ga4_enrichment_active_dedupe). */
const ACTIVE_DEDUPE_INDEX = 'idx_job_queue_brand_presence_active_dedupe';

function isUniqueDedupeConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybeError = error as { code?: string; message?: string };
  return (
    maybeError.code === '23505' ||
    (maybeError.message ?? '').includes(ACTIVE_DEDUPE_INDEX)
  );
}

async function enqueue(
  supabase: SupabaseClient,
  params: {
    type: string;
    dedupeKey: string;
    organizationId: string;
    payload: Record<string, unknown>;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  const existingId = await findActiveJob(
    supabase,
    params.type,
    params.dedupeKey,
  );
  if (existingId) {
    return { jobId: existingId, deduped: true };
  }
  const { data, error } = await supabase
    .from('job_queue')
    .insert({
      type: params.type,
      dedupe_key: params.dedupeKey,
      status: 'pending',
      payload: params.payload,
      organization_id: params.organizationId,
      max_attempts: 3,
    })
    .select('id')
    .single();
  if (error || !data) {
    // The find→insert window is not atomic: concurrent finalizes (e.g. a
    // wave of extract jobs all triggering the cluster rebuild) can pass the
    // probe together. The partial unique active-dedupe index rejects the
    // losers — resolve to the winner instead of failing. Without this, five
    // simultaneous cluster rebuilds raced the themes delete/repoint and
    // corrupted the derived layer (live incident, 2026-07-08).
    if (isUniqueDedupeConflict(error)) {
      const winnerId = await findActiveJob(
        supabase,
        params.type,
        params.dedupeKey,
      );
      if (winnerId) return { jobId: winnerId, deduped: true };
    }
    throw error ?? new Error(`Failed to enqueue ${params.type} job`);
  }
  return { jobId: String(data.id), deduped: false };
}

/**
 * One discovery per (org, URL) at a time — repeat clicks on the SAME brand URL
 * reuse the active job, but discovering a DIFFERENT brand URL in the same org
 * runs concurrently (multi-brand). The dedupe key hashes the URL so it stays
 * index-safe.
 */
export function enqueueBrandPresenceDiscover(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    websiteUrl: string;
    presenceRole?: 'self' | 'competitor';
  },
): Promise<{ jobId: string; deduped: boolean }> {
  const urlHash = createHash('sha256')
    .update(params.websiteUrl)
    .digest('hex')
    .slice(0, 16);
  return enqueue(supabase, {
    type: BRAND_PRESENCE_DISCOVER_JOB_TYPE,
    dedupeKey: `bp_discover:${params.organizationId}:${urlHash}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      websiteUrl: params.websiteUrl,
      ...(params.presenceRole ? { presenceRole: params.presenceRole } : {}),
    },
  });
}

export function enqueueBrandPresenceSubreddits(
  supabase: SupabaseClient,
  params: { organizationId: string; brandProfileId: string },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_PRESENCE_SUBREDDITS_JOB_TYPE,
    dedupeKey: `bp_subreddits:${params.brandProfileId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
    },
  });
}

/** One scrape per source at a time — a re-sync while one is in flight reuses
 * the active job instead of double-running the (billable) actor. */
export function enqueueBrandPresenceScrape(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    refresh?: boolean;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  const target = getBrandPresenceSyncJobTarget('reddit', params.sourceId);
  if (!target || target.kind !== 'dedupe') {
    throw new Error('Reddit sync job identity is not configured');
  }
  return enqueue(supabase, {
    type: target.type,
    dedupeKey: target.dedupeKey,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      refresh: params.refresh ?? false,
    },
  });
}

/**
 * Chunks pending mention ids into relevance batches. Dedupe key is a
 * canonical hash of the sorted batch (fixed-length, index-safe) so a re-run
 * scrape does not double-queue a batch that is already pending.
 */
export async function enqueueRelevanceBatches(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    mentionIds: string[];
  },
  batchSize: number = BRAND_PRESENCE_CONFIG.relevanceBatchSize,
): Promise<{ jobIds: string[]; deduped: number }> {
  const jobIds: string[] = [];
  let deduped = 0;
  for (let i = 0; i < params.mentionIds.length; i += batchSize) {
    const batch = [...params.mentionIds.slice(i, i + batchSize)].sort();
    const dedupeKey = `bp_relevance:${createHash('sha256')
      .update(batch.join(','))
      .digest('hex')}`;
    const result = await enqueue(supabase, {
      type: BRAND_PRESENCE_RELEVANCE_JOB_TYPE,
      dedupeKey,
      organizationId: params.organizationId,
      payload: {
        organizationId: params.organizationId,
        brandProfileId: params.brandProfileId,
        mentionIds: batch,
      },
    });
    jobIds.push(result.jobId);
    if (result.deduped) deduped++;
  }
  return { jobIds, deduped };
}

/** One ASIN-extraction pass per amazon source at a time — re-submitting the
 * setup form while one runs reuses the active job. */
export function enqueueAmazonProducts(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_PRESENCE_AMAZON_PRODUCTS_JOB_TYPE,
    dedupeKey: `bp_amz_products:${params.sourceId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
    },
  });
}

/** One review scrape per product at a time — the (billable) actor never
 * double-runs for the same ASIN. */
export function enqueueAmazonReviews(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    productId: string;
    refresh?: boolean;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_PRESENCE_AMAZON_REVIEWS_JOB_TYPE,
    dedupeKey: `bp_amz_reviews:${params.productId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      productId: params.productId,
      refresh: params.refresh ?? false,
    },
  });
}

/** One resolve probe per google_maps_reviews source at a time —
 * re-submitting the setup form while one runs reuses the active job. */
export function enqueueGooglePlaceResolve(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    autoConfirm?: boolean;
    requestedBy?: UserActivityActor;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_PRESENCE_GOOGLE_PLACE_JOB_TYPE,
    dedupeKey: `bp_google_place:${params.sourceId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      autoConfirm: params.autoConfirm ?? false,
      ...(params.requestedBy ? { requestedBy: params.requestedBy } : {}),
    },
  });
}

/** One review scrape per google_maps_reviews source at a time — the
 * (pay-per-result) actor never double-runs for the same place. */
export function enqueueGoogleReviews(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    refresh?: boolean;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  const target = getBrandPresenceSyncJobTarget(
    'google_maps_reviews',
    params.sourceId,
  );
  if (!target || target.kind !== 'dedupe') {
    throw new Error('Google Maps sync job identity is not configured');
  }
  return enqueue(supabase, {
    type: target.type,
    dedupeKey: target.dedupeKey,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      refresh: params.refresh ?? false,
    },
  });
}

/** One resolve (probe or fallback search) per trustpilot source at a time —
 * re-submitting the setup form while one runs reuses the active job. */
export function enqueueTrustpilotResolve(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    allowSearchFallback?: boolean;
    autoConfirm?: boolean;
    requestedBy?: UserActivityActor;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_PRESENCE_TRUSTPILOT_RESOLVE_JOB_TYPE,
    dedupeKey: `bp_tp_resolve:${params.sourceId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      allowSearchFallback: params.allowSearchFallback ?? true,
      autoConfirm: params.autoConfirm ?? false,
      ...(params.requestedBy ? { requestedBy: params.requestedBy } : {}),
    },
  });
}

/** One review scrape per trustpilot source at a time — the (pay-per-event)
 * actor never double-runs for the same page. */
export function enqueueTrustpilotReviews(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    refresh?: boolean;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  const target = getBrandPresenceSyncJobTarget('trustpilot', params.sourceId);
  if (!target || target.kind !== 'dedupe') {
    throw new Error('Trustpilot sync job identity is not configured');
  }
  return enqueue(supabase, {
    type: target.type,
    dedupeKey: target.dedupeKey,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      refresh: params.refresh ?? false,
    },
  });
}

/** One Hop-1 profile probe per tiktok_comments source at a time —
 * re-submitting the setup form while one runs reuses the active job. */
export function enqueueTikTokProfileResolve(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    autoConfirm?: boolean;
    requestedBy?: UserActivityActor;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_PRESENCE_TIKTOK_PROFILE_JOB_TYPE,
    dedupeKey: `bp_tiktok_profile:${params.sourceId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      autoConfirm: params.autoConfirm ?? false,
      ...(params.requestedBy ? { requestedBy: params.requestedBy } : {}),
    },
  });
}

/** One two-hop harvest per tiktok_comments source at a time — a re-sync
 * while one is in flight reuses the active job instead of double-running
 * the (billable) actors. */
export function enqueueTikTokComments(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    refresh?: boolean;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  const target = getBrandPresenceSyncJobTarget(
    'tiktok_comments',
    params.sourceId,
  );
  if (!target || target.kind !== 'dedupe') {
    throw new Error('TikTok sync job identity is not configured');
  }
  return enqueue(supabase, {
    type: target.type,
    dedupeKey: target.dedupeKey,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      refresh: params.refresh ?? false,
    },
  });
}

/** One details-mode profile probe per instagram_comments source at a time —
 * re-submitting the setup form while one runs reuses the active job. */
export function enqueueInstagramProfileResolve(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    autoConfirm?: boolean;
    requestedBy?: UserActivityActor;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_PRESENCE_INSTAGRAM_PROFILE_JOB_TYPE,
    dedupeKey: `bp_instagram_profile:${params.sourceId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      autoConfirm: params.autoConfirm ?? false,
      ...(params.requestedBy ? { requestedBy: params.requestedBy } : {}),
    },
  });
}

/** One two-hop harvest per instagram_comments source at a time — a re-sync
 * while one is in flight reuses the active job instead of double-running
 * the (billable) actor. */
export function enqueueInstagramComments(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    refresh?: boolean;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  const target = getBrandPresenceSyncJobTarget(
    'instagram_comments',
    params.sourceId,
  );
  if (!target || target.kind !== 'dedupe') {
    throw new Error('Instagram sync job identity is not configured');
  }
  return enqueue(supabase, {
    type: target.type,
    dedupeKey: target.dedupeKey,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      refresh: params.refresh ?? false,
    },
  });
}

/** One X scrape per source at a time — a re-sync while one is in flight
 * reuses the active job instead of double-running the (billable) actor. */
export function enqueueXScrape(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    sourceId: string;
    refresh?: boolean;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  const target = getBrandPresenceSyncJobTarget('x', params.sourceId);
  if (!target || target.kind !== 'dedupe') {
    throw new Error('X sync job identity is not configured');
  }
  return enqueue(supabase, {
    type: target.type,
    dedupeKey: target.dedupeKey,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      sourceId: params.sourceId,
      refresh: params.refresh ?? false,
    },
  });
}

const EXTRACTION_PLATFORM_BUDGETS =
  BRAND_PRESENCE_CONFIG.extract.platformBudgets;
type ExtractionPlatform = keyof typeof EXTRACTION_PLATFORM_BUDGETS;

interface ExtractionCandidate {
  id: string;
  scope: string;
  title: string | null;
  body: string | null;
}

function normalizedCandidateText(candidate: ExtractionCandidate): string {
  return `${candidate.title ?? ''}\n${candidate.body ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Round-robin scopes so one platform's brand/category/competitor corpus is
 * represented without paying to analyze repeated normalized text. Input order
 * is already deterministic (posted_at desc, id asc). */
function selectDiverseCandidates(
  rows: Array<Record<string, unknown>>,
  maxItems: number,
  seenText: Set<string>,
): string[] {
  const buckets = new Map<string, ExtractionCandidate[]>();
  for (const row of rows) {
    const candidate: ExtractionCandidate = {
      id: String(row.id),
      scope: typeof row.scope === 'string' ? row.scope : 'brand',
      title: typeof row.title === 'string' ? row.title : null,
      body: typeof row.body === 'string' ? row.body : null,
    };
    const text = normalizedCandidateText(candidate);
    if (text && seenText.has(text)) continue;
    if (text) seenText.add(text);
    const bucket = buckets.get(candidate.scope) ?? [];
    bucket.push(candidate);
    buckets.set(candidate.scope, bucket);
  }

  const scopes = [...buckets.keys()].sort();
  const selected: string[] = [];
  for (let index = 0; selected.length < maxItems; index++) {
    let added = false;
    for (const scope of scopes) {
      const candidate = buckets.get(scope)?.[index];
      if (!candidate) continue;
      selected.push(candidate.id);
      added = true;
      if (selected.length >= maxItems) break;
    }
    if (!added) break;
  }
  return selected;
}

async function hasOtherActiveExtractJobs(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    excludeJobId?: string;
  },
): Promise<boolean> {
  let query = supabase
    .from('job_queue')
    .select('id')
    .eq('type', BRAND_PRESENCE_EXTRACT_JOB_TYPE)
    .eq('organization_id', params.organizationId)
    .eq('payload->>brandProfileId', params.brandProfileId)
    .in('status', ['pending', 'processing'])
    .limit(2);
  if (params.excludeJobId) query = query.neq('id', params.excludeJobId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** True while any discovery/relevance/extraction job for this profile can
 * still add or analyze mentions. Cluster jobs are deliberately excluded. */
export async function hasActiveBrandPresenceAnalysisJobs(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    excludeJobId?: string;
  },
): Promise<boolean> {
  const pipelineTypes = BRAND_PRESENCE_JOB_TYPES.filter(
    (type) => type !== BRAND_PRESENCE_CLUSTER_JOB_TYPE,
  );
  let query = supabase
    .from('job_queue')
    .select('id')
    .eq('organization_id', params.organizationId)
    .eq('payload->>brandProfileId', params.brandProfileId)
    .in('type', [...pipelineTypes])
    .in('status', ['pending', 'processing'])
    .limit(2);
  if (params.excludeJobId) query = query.neq('id', params.excludeJobId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Mentions eligible for phrase extraction: every KEPT mention still awaiting
 * the extract pass, sampled deterministically inside one explicit budget per
 * platform. Existing completed extractions consume the same budget, so later
 * finalize waves cannot exceed the 1,500-mention onboarding ceiling.
 */
export async function gatherExtractEligibleIds(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    excludeJobId?: string;
    excludeMentionIds?: string[];
  },
): Promise<string[]> {
  if (await hasOtherActiveExtractJobs(supabase, params)) return [];

  const seenText = new Set<string>();
  const excludedIds = new Set(params.excludeMentionIds ?? []);
  const platformSelections = await Promise.all(
    (
      Object.entries(EXTRACTION_PLATFORM_BUDGETS) as Array<
        [ExtractionPlatform, number]
      >
    ).map(async ([platform, budget]) => {
      const { count: completed, error: countError } = await supabase
        .from('brand_mentions')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', params.organizationId)
        .eq('brand_profile_id', params.brandProfileId)
        .eq('platform', platform)
        .eq('extraction_status', 'done');
      if (countError) throw countError;
      const remaining = Math.max(0, budget - (completed ?? 0));
      if (remaining === 0) return [];

      const { data, error } = await supabase
        .from('brand_mentions')
        .select('id, platform, scope, title, body, posted_at')
        .eq('organization_id', params.organizationId)
        .eq('brand_profile_id', params.brandProfileId)
        .eq('platform', platform)
        .in('relevance', ['relevant', 'not_required'])
        .eq('extraction_status', 'pending')
        .order('posted_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .limit(
          remaining * BRAND_PRESENCE_CONFIG.extract.candidatePoolMultiplier,
        );
      if (error) throw error;
      const rows = ((data ?? []) as Array<Record<string, unknown>>).filter(
        (row) =>
          !excludedIds.has(String(row.id)) &&
          (typeof row.platform !== 'string' || row.platform === platform),
      );
      return { rows, remaining };
    }),
  );

  const selected: string[] = [];
  const selectedIds = new Set<string>();
  for (const selection of platformSelections) {
    if (Array.isArray(selection)) continue;
    for (const id of selectDiverseCandidates(
      selection.rows,
      selection.remaining,
      seenText,
    )) {
      if (selectedIds.has(id)) continue;
      selectedIds.add(id);
      selected.push(id);
    }
  }
  return selected.slice(0, BRAND_PRESENCE_CONFIG.extract.maxPerOnboarding);
}

/** Raw mentions remain stored, but once no selected wave remains, pending
 * over-budget/duplicate rows stop blocking the final theme rebuild. */
export async function skipOverBudgetExtractMentions(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    excludeJobId?: string;
  },
): Promise<void> {
  if (await hasOtherActiveExtractJobs(supabase, params)) return;
  await Promise.all(
    (Object.keys(EXTRACTION_PLATFORM_BUDGETS) as ExtractionPlatform[]).map(
      async (platform) => {
        const { error } = await supabase
          .from('brand_mentions')
          .update({ extraction_status: 'skipped' })
          .eq('organization_id', params.organizationId)
          .eq('brand_profile_id', params.brandProfileId)
          .eq('platform', platform)
          .in('relevance', ['relevant', 'not_required'])
          .eq('extraction_status', 'pending');
        if (error) throw error;
      },
    ),
  );
}

/** Queue one final theme rebuild only after the whole profile pipeline has
 * drained. Source/relevance processors call this on terminal no-signal paths;
 * the extract processor calls it after embedding its last wave. */
export async function enqueueClusterIfAnalysisDrained(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    excludeJobId?: string;
  },
): Promise<{
  jobId: string;
  deduped: boolean;
  unthemedPhrases: number;
} | null> {
  if (await hasActiveBrandPresenceAnalysisJobs(supabase, params)) return null;

  await skipOverBudgetExtractMentions(supabase, params);
  const [pendingResult, unthemedResult] = await Promise.all([
    supabase
      .from('brand_mentions')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', params.organizationId)
      .eq('brand_profile_id', params.brandProfileId)
      .eq('extraction_status', 'pending')
      .in('relevance', ['relevant', 'not_required']),
    supabase
      .from('brand_presence_phrases')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', params.organizationId)
      .eq('brand_profile_id', params.brandProfileId)
      .neq('kind', 'quote')
      .is('theme_id', null)
      .not('embedding', 'is', null),
  ]);
  if (pendingResult.error) throw pendingResult.error;
  if (unthemedResult.error) throw unthemedResult.error;
  const pending = pendingResult.count ?? 0;
  const unthemedPhrases = unthemedResult.count ?? 0;
  if (pending > 0 || unthemedPhrases === 0) return null;

  const queued = await enqueueClusterRun(supabase, {
    organizationId: params.organizationId,
    brandProfileId: params.brandProfileId,
  });
  return { ...queued, unthemedPhrases };
}

/**
 * Chunks mention ids into extraction batches. Canonical-hash dedupe key
 * (sorted ids) keeps a re-run from double-queuing an in-flight batch.
 */
export async function enqueueExtractBatches(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    mentionIds: string[];
  },
  batchSize: number = BRAND_PRESENCE_CONFIG.extract.batchSize,
): Promise<{ jobIds: string[]; deduped: number }> {
  const jobIds: string[] = [];
  let deduped = 0;
  for (let i = 0; i < params.mentionIds.length; i += batchSize) {
    const batch = [...params.mentionIds.slice(i, i + batchSize)].sort();
    const dedupeKey = `bp_extract:${createHash('sha256')
      .update(batch.join(','))
      .digest('hex')}`;
    const result = await enqueue(supabase, {
      type: BRAND_PRESENCE_EXTRACT_JOB_TYPE,
      dedupeKey,
      organizationId: params.organizationId,
      payload: {
        organizationId: params.organizationId,
        brandProfileId: params.brandProfileId,
        mentionIds: batch,
      },
    });
    jobIds.push(result.jobId);
    if (result.deduped) deduped++;
  }
  return { jobIds, deduped };
}

export interface ExtractOrDrainResult {
  /** Mentions this pass found still awaiting extraction. */
  extractIds: string[];
  /** Set when a new extraction wave was queued; null on the drain path. */
  batches: { jobIds: string[]; deduped: number } | null;
  /** Set when this call queued the final theme rebuild; null otherwise. */
  cluster: { jobId: string; deduped: boolean; unthemedPhrases: number } | null;
}

/**
 * The ONE terminal branch every brand-presence SOURCE processor must run at
 * the end of its finalize: gather the extract-eligible mentions and either
 * queue the next extraction wave, or — when there is nothing left to extract
 * — queue the final theme rebuild if the rest of the profile pipeline has
 * drained.
 *
 * Whichever pipeline job finishes LAST owns the drain check, so a processor
 * that only has the `enqueueExtractBatches` half silently strands the brand:
 * live incident 2026-09-16 (ABF Ohana, profile 251b25a4) — six extract jobs
 * each bailed on the drain check because an Instagram comments job was still
 * processing, that Instagram job then finished last with zero eligible
 * mentions and never called the drain, and 497 brand-scope phrases stayed at
 * `theme_id = NULL` forever (zero themes → zero `voc_*` facts → the report's
 * Chapter 03 stuck on "distilling into your report…").
 *
 * `excludeJobId` is REQUIRED and is the crux: the calling job's own row is
 * still `status='processing'` with a type inside BRAND_PRESENCE_JOB_TYPES, so
 * `hasActiveBrandPresenceAnalysisJobs` sees the caller itself and refuses
 * forever unless it is excluded. Passing it is what makes the call do
 * anything at all — omit it and the whole path is a silent no-op.
 *
 * Structural regression guard:
 * `tests/unit/job-processor/brand-presence/extract-drain-call-sites.structural.test.ts`.
 */
export async function enqueueExtractOrDrainCluster(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    excludeJobId: string;
  },
): Promise<ExtractOrDrainResult> {
  const scope = {
    organizationId: params.organizationId,
    brandProfileId: params.brandProfileId,
  };
  const extractIds = await gatherExtractEligibleIds(supabase, {
    ...scope,
    // The caller is never an extract job (`hasOtherActiveExtractJobs` only
    // looks at that type), but excluding self is always correct.
    excludeJobId: params.excludeJobId,
  });
  if (extractIds.length > 0) {
    const batches = await enqueueExtractBatches(supabase, {
      ...scope,
      mentionIds: extractIds,
    });
    return { extractIds, batches, cluster: null };
  }
  const cluster = await enqueueClusterIfAnalysisDrained(supabase, {
    ...scope,
    excludeJobId: params.excludeJobId,
  });
  return { extractIds, batches: null, cluster };
}

/** One cluster rebuild per brand at a time — themes are a full derived
 * rebuild, so a trigger firing mid-run just rides the next run. */
export function enqueueClusterRun(
  supabase: SupabaseClient,
  params: { organizationId: string; brandProfileId: string },
): Promise<{ jobId: string; deduped: boolean }> {
  const target = getBrandPresenceClusterJobTarget(params.brandProfileId);
  return enqueue(supabase, {
    type: target.type,
    dedupeKey: target.dedupeKey,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
    },
  });
}

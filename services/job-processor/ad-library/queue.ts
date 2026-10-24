import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ADLIB_EMBED_BATCH_JOB_TYPE,
  ADLIB_LABEL_BATCH_JOB_TYPE,
  ADLIB_MEDIA_REHOST_JOB_TYPE,
  ADLIB_SYNC_COMPETITOR_JOB_TYPE,
} from './types';
import {
  findUnembeddedAdIds,
  findUnlabeledAdIds,
} from './sync/persistence';

const LABEL_BATCH_SIZE = 15;
const EMBED_BATCH_SIZE = 32;
const REHOST_BATCH_SIZE = 8;

async function findActiveJob(
  supabase: SupabaseClient,
  type: string,
  dedupeKey: string
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

/**
 * Enqueues a competitor sync, deduped on the competitor id so repeated
 * "Sync now" clicks (or the daily cron racing a manual trigger) reuse the
 * active job.
 */
export async function enqueueAdlibSyncJob(
  supabase: SupabaseClient,
  params: { organizationId: string; competitorId: string }
): Promise<{ jobId: string; deduped: boolean }> {
  const dedupeKey = `adlib_sync:${params.competitorId}`;
  const existingId = await findActiveJob(
    supabase,
    ADLIB_SYNC_COMPETITOR_JOB_TYPE,
    dedupeKey
  );
  if (existingId) {
    // A deduped re-enqueue reuses the active run and spends nothing, so it does
    // not count against the per-org ingestion cap.
    return { jobId: existingId, deduped: true };
  }

  const { data, error } = await supabase
    .from('job_queue')
    .insert({
      type: ADLIB_SYNC_COMPETITOR_JOB_TYPE,
      dedupe_key: dedupeKey,
      status: 'pending',
      payload: {
        organizationId: params.organizationId,
        competitorId: params.competitorId,
      },
      organization_id: params.organizationId,
      max_attempts: 3,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw error ?? new Error('Failed to enqueue ad library sync job');
  }
  return { jobId: String(data.id), deduped: false };
}

/**
 * Chunks ad ids into per-batch enrichment jobs. The dedupe key is a canonical
 * hash of the sorted batch ids (fixed-length, index-safe) so a re-run sync does
 * not double-queue the same batch while one is pending.
 */
async function enqueueAdBatches(
  supabase: SupabaseClient,
  jobType: string,
  dedupePrefix: string,
  organizationId: string,
  libraryAdIds: string[],
  batchSize: number
): Promise<{ jobIds: string[]; deduped: number }> {
  const jobIds: string[] = [];
  let deduped = 0;

  for (let i = 0; i < libraryAdIds.length; i += batchSize) {
    const batch = [...libraryAdIds.slice(i, i + batchSize)].sort();
    const dedupeKey = `${dedupePrefix}:${createHash('sha256')
      .update(batch.join(','))
      .digest('hex')}`;

    const existingId = await findActiveJob(supabase, jobType, dedupeKey);
    if (existingId) {
      jobIds.push(existingId);
      deduped++;
      continue;
    }

    const { data, error } = await supabase
      .from('job_queue')
      .insert({
        type: jobType,
        dedupe_key: dedupeKey,
        status: 'pending',
        payload: { organizationId, libraryAdIds: batch },
        organization_id: organizationId,
        max_attempts: 3,
      })
      .select('id')
      .single();
    if (error || !data) {
      throw error ?? new Error(`Failed to enqueue ${jobType} job`);
    }
    jobIds.push(String(data.id));
  }

  return { jobIds, deduped };
}

/** Chunks unlabeled ad ids into adlib_label_batch jobs. */
export function enqueueLabelBatches(
  supabase: SupabaseClient,
  organizationId: string,
  libraryAdIds: string[],
  batchSize = LABEL_BATCH_SIZE
): Promise<{ jobIds: string[]; deduped: number }> {
  return enqueueAdBatches(
    supabase,
    ADLIB_LABEL_BATCH_JOB_TYPE,
    'adlib_label',
    organizationId,
    libraryAdIds,
    batchSize
  );
}

/** Chunks unembedded ad ids into adlib_embed_batch jobs. */
export function enqueueEmbedBatches(
  supabase: SupabaseClient,
  organizationId: string,
  libraryAdIds: string[],
  batchSize = EMBED_BATCH_SIZE
): Promise<{ jobIds: string[]; deduped: number }> {
  return enqueueAdBatches(
    supabase,
    ADLIB_EMBED_BATCH_JOB_TYPE,
    'adlib_embed',
    organizationId,
    libraryAdIds,
    batchSize
  );
}

/** Re-enqueues enrichment work for ads stranded after prior job failures. */
export async function enqueueEnrichmentCatchUp(
  supabase: SupabaseClient,
  params: { organizationId: string; competitorId: string }
): Promise<{ labelJobs: number; embedJobs: number }> {
  const [unlabeledAdIds, unembeddedAdIds] = await Promise.all([
    findUnlabeledAdIds(
      supabase,
      params.organizationId,
      params.competitorId
    ),
    findUnembeddedAdIds(
      supabase,
      params.organizationId,
      params.competitorId
    ),
  ]);

  let labelJobs = 0;
  if (unlabeledAdIds.length > 0) {
    const result = await enqueueLabelBatches(
      supabase,
      params.organizationId,
      unlabeledAdIds
    );
    labelJobs = result.jobIds.length - result.deduped;
  }

  let embedJobs = 0;
  if (unembeddedAdIds.length > 0) {
    const result = await enqueueEmbedBatches(
      supabase,
      params.organizationId,
      unembeddedAdIds
    );
    embedJobs = result.jobIds.length - result.deduped;
  }

  return { labelJobs, embedJobs };
}

/** Chunks ads with fresh network media into adlib_media_rehost jobs. */
export function enqueueRehostBatches(
  supabase: SupabaseClient,
  organizationId: string,
  libraryAdIds: string[],
  batchSize = REHOST_BATCH_SIZE
): Promise<{ jobIds: string[]; deduped: number }> {
  return enqueueAdBatches(
    supabase,
    ADLIB_MEDIA_REHOST_JOB_TYPE,
    'adlib_rehost',
    organizationId,
    libraryAdIds,
    batchSize
  );
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedAd } from '@/services/ad-library/types';
import { r2Service } from '@/services/r2-service';
import { primaryBody } from '@/services/ad-library/embeddings';
import {
  computeSignalCaptureUpdates,
  type ExistingSignalRow,
  type SignalCaptureUpdate,
} from './signal-capture';
import { UPSERT_CHUNK_SIZE } from './types';

const R2_BUCKET = 'adcero-ad-creatives';

function adToRow(
  ad: NormalizedAd,
  organizationId: string,
  competitorId: string,
  platform: string,
  nowIso: string,
  rawRef: string | null,
) {
  return {
    organization_id: organizationId,
    competitor_id: competitorId,
    external_ad_id: ad.externalAdId,
    platform,
    ad_snapshot_url: ad.adSnapshotUrl,
    creative_bodies: ad.creativeBodies,
    creative_link_titles: ad.creativeLinkTitles,
    page_name: ad.pageName,
    publisher_platforms: ad.publisherPlatforms,
    delivery_start: ad.deliveryStart,
    delivery_stop: ad.deliveryStop,
    eu_total_reach: ad.euTotalReach,
    currency: ad.currency,
    spend_range: ad.spendRange,
    media_type: ad.mediaType,
    media_urls: ad.mediaUrls,
    video_urls: ad.videoUrls ?? null,
    num_served_days: ad.numServedDays ?? null,
    landing_url: ad.landingUrl ?? null,
    landing_domain: ad.landingDomain ?? null,
    raw_ref: rawRef,
    last_seen_at: nowIso,
    updated_at: nowIso,
    // first_seen_at intentionally omitted: defaults on insert, untouched on
    // conflict update — that is the idempotency contract for re-syncs.
  };
}

export async function upsertAds(
  db: SupabaseClient,
  ads: NormalizedAd[],
  organizationId: string,
  competitorId: string,
  platform: string,
  nowIso: string,
  rawRef: string | null,
): Promise<void> {
  // Pre-read BEFORE the upsert: delivery_start/delivery_stop/eu_total_reach
  // are blind-overwritten on conflict, so relaunch and reach deltas are only
  // observable here. Best-effort — a failed read skips signal capture, never
  // the sync.
  const existing =
    ads.length > 0
      ? await readExistingSignalRows(db, ads, organizationId, platform)
      : null;

  const rows = ads.map((ad) =>
    adToRow(ad, organizationId, competitorId, platform, nowIso, rawRef),
  );
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const { error } = await db
      .from('library_ads')
      .upsert(rows.slice(i, i + UPSERT_CHUNK_SIZE), {
        onConflict: 'organization_id,platform,external_ad_id',
      });
    if (error) throw error;
  }

  if (existing) {
    const updates = computeSignalCaptureUpdates(ads, existing, nowIso);
    if (updates.length > 0) {
      await persistSignalCaptureUpdates(db, updates, organizationId, platform);
    }
  }
}

/**
 * Chunked pre-read of the sync-delta columns for the incoming ads. Returns
 * null on any read error (capture is skipped; the sync itself never fails).
 */
async function readExistingSignalRows(
  db: SupabaseClient,
  ads: NormalizedAd[],
  organizationId: string,
  platform: string,
): Promise<Map<string, ExistingSignalRow> | null> {
  const ids = [...new Set(ads.map((ad) => ad.externalAdId))];
  const map = new Map<string, ExistingSignalRow>();
  for (let i = 0; i < ids.length; i += UPSERT_CHUNK_SIZE) {
    const { data, error } = await db
      .from('library_ads')
      .select('external_ad_id, delivery_start, delivery_stop, scores')
      .eq('organization_id', organizationId)
      .eq('platform', platform)
      .in('external_ad_id', ids.slice(i, i + UPSERT_CHUNK_SIZE));
    if (error) {
      console.warn(
        `[AdLibSync] signal-capture pre-read failed (capture skipped): ${error.message}`,
      );
      return null;
    }
    for (const row of (data ?? []) as ExistingSignalRow[]) {
      map.set(row.external_ad_id, row);
    }
  }
  return map;
}

/**
 * Persists the merged `scores` for ads whose signal state changed. The rows
 * were upserted moments ago, so the conflict path always fires and only the
 * supplied `scores` column is touched. Best-effort: a failure loses one
 * sync's capture, never the sync.
 */
async function persistSignalCaptureUpdates(
  db: SupabaseClient,
  updates: SignalCaptureUpdate[],
  organizationId: string,
  platform: string,
): Promise<void> {
  for (let i = 0; i < updates.length; i += UPSERT_CHUNK_SIZE) {
    const rows = updates.slice(i, i + UPSERT_CHUNK_SIZE).map((update) => ({
      organization_id: organizationId,
      platform,
      external_ad_id: update.externalAdId,
      scores: update.scores,
    }));
    const { error } = await db.from('library_ads').upsert(rows, {
      onConflict: 'organization_id,platform,external_ad_id',
    });
    if (error) {
      console.warn(
        `[AdLibSync] signal-capture scores write failed (non-fatal): ${error.message}`,
      );
    }
  }
}

/**
 * Raw payload archival is best-effort: a missing R2 page never fails a sync.
 * Cache-eligible scrapes archive under a shared cache-key-addressed path
 * (the payload is public data every same-identity org shares — one copy,
 * and cache-served rows can point their raw_ref at it); mock/no-cache runs
 * keep the org-scoped path.
 */
export async function storeRawPayload(
  organizationId: string,
  competitorId: string,
  syncIso: string,
  page: number,
  rawPayload: unknown,
  cacheKey?: string,
): Promise<string | null> {
  const key = cacheKey
    ? `ad-library/shared/${cacheKey}/${syncIso}-page${page}.json`
    : `ad-library/${organizationId}/${competitorId}/${syncIso}-page${page}.json`;
  try {
    await r2Service.uploadFile(
      R2_BUCKET,
      key,
      JSON.stringify(rawPayload),
      'application/json',
      { source: 'adlib-sync' },
    );
    return key;
  } catch (error) {
    console.warn(
      `[AdLibSync] Failed to store raw payload for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Marks this job's queue row as served-from-cache so assertOrgSyncBudget
 * excludes it from the daily Apify-spend count (the enqueue-time budget
 * check cannot know hit/miss). Best-effort — never fails the sync, and the
 * completion path (complete_job_with_token) only touches status, so the
 * stamp survives.
 */
export async function markJobCacheServed(
  db: SupabaseClient,
  jobId: string,
): Promise<void> {
  try {
    const { error } = await db
      .from('job_queue')
      .update({ result: { servedFromCache: true } })
      .eq('id', jobId);
    if (error) throw error;
  } catch (error) {
    console.warn(
      `[AdLibSync] Failed to stamp cache-served on job ${jobId}: ${
        (error as Error).message
      }`,
    );
  }
}

/** Removes leftover mock-seeded ads for a competitor (cascades to ad_labels). */
export async function purgeMockRows(
  db: SupabaseClient,
  organizationId: string,
  competitorId: string,
): Promise<void> {
  const { error } = await db
    .from('library_ads')
    .delete()
    .eq('organization_id', organizationId)
    .eq('competitor_id', competitorId)
    .like('external_ad_id', 'mock-%');
  if (error) {
    console.warn(
      `[AdLibSync] Failed to purge mock rows for ${competitorId}: ${error.message}`,
    );
  }
}

export async function setSyncRunCheckpoint(
  db: SupabaseClient,
  competitorId: string,
  runId: string,
  startedIso: string,
): Promise<void> {
  const { error } = await db
    .from('tracked_competitors')
    .update({ sync_run_id: runId, sync_run_started_at: startedIso })
    .eq('id', competitorId);
  if (error) throw error;
}

export async function clearSyncRunCheckpoint(
  db: SupabaseClient,
  competitorId: string,
): Promise<void> {
  const { error } = await db
    .from('tracked_competitors')
    .update({ sync_run_id: null, sync_run_started_at: null })
    .eq('id', competitorId);
  if (error) throw error;
}

/**
 * How many ads this sync newly inserted — the cadence yield signal. `upsertAds`
 * omits `first_seen_at`, so a brand-new row defaults it to insert time (≥ the
 * sync's start), while a conflict update leaves the original untouched. Counting
 * rows with `first_seen_at >= syncIso` therefore counts only genuinely-new ads.
 * Returns null (not 0) on a read error so cadence diagnostics stay active
 * instead of falsely treating the competitor as cold.
 */
export async function countNewAds(
  db: SupabaseClient,
  organizationId: string,
  competitorId: string,
  syncIso: string,
): Promise<number | null> {
  const { count, error } = await db
    .from('library_ads')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('competitor_id', competitorId)
    .gte('first_seen_at', syncIso);
  if (error) {
    console.warn(
      `[AdLibSync] Failed to count new ads for ${competitorId}: ${error.message}`,
    );
    return null;
  }
  return count ?? 0;
}

export function findUnlabeledAdIds(
  db: SupabaseClient,
  organizationId: string,
  competitorId: string,
): Promise<string[]> {
  return findAdIdsMissingFrom(db, organizationId, competitorId, 'ad_labels');
}

/**
 * Ads needing an `ad_embeddings` row. Ads with no embeddable copy (video ads
 * with no body, template-only bodies) are excluded via the SAME `primaryBody`
 * logic the embed processor uses to decide what to embed: it returns null for
 * them, skips them, and never writes a row — so without this filter they read
 * as "unembedded" forever and get re-enqueued as no-op embed jobs every day
 * per competitor (e.g. BetMGM's 39 permanently-unembeddable ads). Keeping the
 * scan self-consistent with the processor makes them recognizable as done.
 */
export function findUnembeddedAdIds(
  db: SupabaseClient,
  organizationId: string,
  competitorId: string,
): Promise<string[]> {
  return findAdIdsMissingFrom(
    db,
    organizationId,
    competitorId,
    'ad_embeddings',
    {
      select: 'id, creative_bodies',
      keep: (row) =>
        primaryBody(
          (row as { creative_bodies: string[] | null }).creative_bodies,
        ) !== null,
    },
  );
}

interface RehostCandidateRow {
  id: string;
  tags: Record<string, unknown> | null;
  updated_at: string;
}

/**
 * Ads whose media has never been rehosted, or whose raw URLs were refreshed by
 * a newer sync after the last attempt. Filtering in application code keeps the
 * PostgREST JSON-path query readable while retaining explicit org scoping.
 */
export async function findAdIdsNeedingRehost(
  db: SupabaseClient,
  organizationId: string,
  competitorId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from('library_ads')
    .select('id, tags, updated_at')
    .eq('organization_id', organizationId)
    .eq('competitor_id', competitorId);
  if (error) throw error;

  return ((data ?? []) as RehostCandidateRow[])
    .filter((row) => {
      const stamp = row.tags?.mediaRehostAt;
      if (typeof stamp !== 'string') return true;
      const stampMs = Date.parse(stamp);
      const updatedMs = Date.parse(row.updated_at);
      return !Number.isFinite(stampMs) ||
        (Number.isFinite(updatedMs) && stampMs < updatedMs);
    })
    .map((row) => String(row.id));
}

/**
 * Ad ids for this competitor that have no row in an enrichment table keyed by
 * library_ad_id (ad_labels / ad_embeddings). Existence lookups are chunked so
 * large competitors stay within PostgREST `.in()` limits.
 *
 * `opts.select`/`opts.keep` let a caller widen the column read and drop ads that
 * can never gain an enrichment row (see `findUnembeddedAdIds`); the filter runs
 * BEFORE the presence check so those ads are excluded, not just unmatched.
 */
async function findAdIdsMissingFrom(
  db: SupabaseClient,
  organizationId: string,
  competitorId: string,
  table: 'ad_labels' | 'ad_embeddings',
  opts: {
    select?: string;
    keep?: (_row: Record<string, unknown>) => boolean;
  } = {},
): Promise<string[]> {
  const { data: ads, error: adsError } = await db
    .from('library_ads')
    .select(opts.select ?? 'id')
    .eq('organization_id', organizationId)
    .eq('competitor_id', competitorId);
  if (adsError) throw adsError;
  const rows = (ads ?? []) as unknown as Array<Record<string, unknown>>;
  const kept = opts.keep ? rows.filter(opts.keep) : rows;
  const adIds = kept.map((row) => String(row.id));
  if (adIds.length === 0) return [];

  const present = new Set<string>();
  for (let i = 0; i < adIds.length; i += UPSERT_CHUNK_SIZE) {
    const { data: rows, error } = await db
      .from(table)
      .select('library_ad_id')
      .eq('organization_id', organizationId)
      .in('library_ad_id', adIds.slice(i, i + UPSERT_CHUNK_SIZE));
    if (error) throw error;
    for (const row of rows ?? []) {
      present.add(String(row.library_ad_id));
    }
  }

  return adIds.filter((id) => !present.has(id));
}

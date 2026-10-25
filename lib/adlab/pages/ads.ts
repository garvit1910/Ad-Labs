import type { SupabaseClient } from '@supabase/supabase-js';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { buildDashboard, buildWinnerEvaluator, type WinnerEvalRow } from '@/lib/brand-identity/dashboard';
import { computeReplication, type AdVector } from '@/lib/brand-identity/signals';
import { serializeEnrichedAd, type EnrichedAdRow, type TrackedCompetitor } from '@/lib/brand-identity/types';
import type { BrandType } from '@/lib/brand-identity/win-profile';
import { EMBEDDING_MODEL, parseVectorLiteral } from '@/services/ad-library/embeddings';
import { ADLIB_SYNC_COMPETITOR_JOB_TYPE } from '@/services/job-processor/ad-library/types';
import { dbError } from './http';

/**
 * Competitor ad readers for the Competitor Analysis page (A7), ported from
 * Adcero's app/api/brand-identity/shared/helpers.ts and the competitors/list
 * and dashboard routes. The brand's own page (`is_brand_self`) is excluded
 * everywhere, from the competitor list AND from the dashboard's ad rows, so
 * the stat band and the dashboard count the same ads and
 * `dashboard.scope.provenWinners === Σ competitors[].winnerCount`.
 *
 * Exported for reuse (A6's competitor-summary imports these so the ASI:One
 * card and the page show the same numbers). Server-only.
 */

/**
 * Read every matching row from `library_ads_enriched`, paging past
 * PostgREST's silent 1,000-row cap (ordered by id so paging is stable).
 * `platform: 'all'` (or omitted) reads both platforms; an empty
 * `competitorIds` array returns [] without a query.
 */
export async function fetchAllEnrichedAdRows<T = EnrichedAdRow>(
  db: SupabaseClient,
  params: {
    organizationId: string;
    /** Columns to select; defaults to `*`. */
    columns?: string;
    competitorId?: string;
    competitorIds?: string[];
    platform?: string;
  }
): Promise<T[]> {
  if (params.competitorIds && params.competitorIds.length === 0) return [];
  const PAGE_SIZE = 1000;
  const columns = params.columns ?? '*';
  const all: T[] = [];

  for (let page = 0; ; page++) {
    let query = db.from('library_ads_enriched').select(columns).eq('organization_id', params.organizationId);
    if (params.competitorId) query = query.eq('competitor_id', params.competitorId);
    if (params.competitorIds) query = query.in('competitor_id', params.competitorIds);
    if (params.platform && params.platform !== 'all') query = query.eq('platform', params.platform);

    const from = page * PAGE_SIZE;
    const { data, error } = await query.order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw dbError('Failed to load library ads', error);

    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/** Chunk size for the embedding `.in()` read so the URL stays short. */
const EMBEDDING_FETCH_CHUNK = 200;
/** Chunks fetched concurrently. */
const EMBEDDING_FETCH_PARALLELISM = 4;
/**
 * An ad's copy embedding never changes once written, so vectors are cached by
 * ad id for the life of the server process: a dashboard reload then moves no
 * vector text (about 3 MB for 194 ads). Ads still missing an embedding are
 * simply re-queried next time.
 */
const vectorCache = new Map<string, AdVector>();

/**
 * Persisted copy embeddings for a set of ads, keyed by ad id. Rows without a
 * parseable vector or a recorded model are skipped (read as "not yet scored").
 */
export async function loadAdVectors(
  db: SupabaseClient,
  organizationId: string,
  adIds: string[]
): Promise<Map<string, AdVector>> {
  const vectors = new Map<string, AdVector>();
  const missing: string[] = [];
  for (const id of adIds) {
    const cached = vectorCache.get(`${organizationId}:${id}`);
    if (cached) vectors.set(id, cached);
    else missing.push(id);
  }

  const chunks: string[][] = [];
  for (let i = 0; i < missing.length; i += EMBEDDING_FETCH_CHUNK) {
    chunks.push(missing.slice(i, i + EMBEDDING_FETCH_CHUNK));
  }
  for (let i = 0; i < chunks.length; i += EMBEDDING_FETCH_PARALLELISM) {
    const wave = chunks.slice(i, i + EMBEDDING_FETCH_PARALLELISM);
    const results = await Promise.all(
      wave.map((chunk) =>
        db
          .from('ad_embeddings')
          .select('library_ad_id, embedding, embedding_model')
          .eq('organization_id', organizationId)
          .in('library_ad_id', chunk)
      )
    );
    for (const { data, error } of results) {
      if (error) throw dbError('Failed to load ad embeddings', error);
      for (const row of data ?? []) {
        const vec = parseVectorLiteral(row.embedding);
        if (vec && typeof row.embedding_model === 'string') {
          const vector: AdVector = { vector: vec, embeddingModel: row.embedding_model };
          vectors.set(String(row.library_ad_id), vector);
          vectorCache.set(`${organizationId}:${row.library_ad_id}`, vector);
        }
      }
    }
  }
  return vectors;
}

/** Ad Lab's tracked_competitors rows: `self: false` = competitors, `true` = Magic Spoon's own page. */
export async function loadTrackedCompetitors(
  db: SupabaseClient,
  { self }: { self: boolean }
): Promise<TrackedCompetitor[]> {
  const { data, error } = await db
    .from('tracked_competitors')
    .select('*')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('is_brand_self', self)
    .order('created_at', { ascending: true });
  if (error) throw dbError('Failed to list competitors', error);
  return (data ?? []) as TrackedCompetitor[];
}

function brandTypeOf(competitor: TrackedCompetitor): BrandType {
  return ((competitor as { brand_type?: BrandType | null }).brand_type ?? 'unknown') as BrandType;
}

/** The enriched-ad columns the per-competitor counters and the winner test read. */
type CountRow = {
  id: string;
  competitor_id: string;
  platform: string | null;
  media_type: string | null;
  eu_total_reach: number | null;
  num_served_days: number | null;
  hook_archetype: string | null;
  is_active: boolean;
  longevity_days: number;
};

export type CompetitorWithCounts = TrackedCompetitor & {
  adCount: number;
  labeledCount: number;
  activeCount: number;
  winnerCount: number;
  syncing: boolean;
  syncFailed: boolean;
};

/**
 * The competitor list with per-competitor ad, label, active and proven-winner
 * counts (Adcero's competitors/list route). Winners use the same cohort-aware
 * classifier as the dashboard; cohorts are competitor × surface, so one
 * evaluator over all rows gives each competitor its own thresholds.
 */
export async function listCompetitorsWithCounts(db: SupabaseClient): Promise<CompetitorWithCounts[]> {
  const competitors = await loadTrackedCompetitors(db, { self: false });

  // Latest adlib_sync_competitor job per competitor (dedupe key
  // `adlib_sync:<competitorId>`), newest first, so a live Scout sync shows as
  // "Syncing…" and a failed first sync is surfaced.
  const { data: recentSyncJobs, error: syncJobsError } = await db
    .from('job_queue')
    .select('dedupe_key, status')
    .eq('type', ADLIB_SYNC_COMPETITOR_JOB_TYPE)
    .eq('organization_id', ADLAB_ORG_ID)
    .order('created_at', { ascending: false })
    .limit(500);
  if (syncJobsError) throw dbError('Failed to load sync jobs', syncJobsError);
  const latestSyncStatus = new Map<string, string>();
  for (const job of recentSyncJobs ?? []) {
    const competitorId = String(job.dedupe_key ?? '').replace('adlib_sync:', '');
    if (!latestSyncStatus.has(competitorId)) latestSyncStatus.set(competitorId, String(job.status));
  }

  const adRows = await fetchAllEnrichedAdRows<CountRow>(db, {
    organizationId: ADLAB_ORG_ID,
    columns:
      'id, competitor_id, platform, media_type, eu_total_reach, num_served_days, hook_archetype, is_active, longevity_days',
    competitorIds: competitors.map((c) => c.id),
  });

  const brandTypeByCompetitor = new Map<string, BrandType>(
    competitors.map((c) => [String(c.id), brandTypeOf(c)])
  );
  const evaluator = buildWinnerEvaluator(adRows as unknown as WinnerEvalRow[], brandTypeByCompetitor);

  const counts = new Map<string, { adCount: number; labeledCount: number; activeCount: number; winnerCount: number }>();
  for (const row of adRows) {
    const key = String(row.competitor_id);
    const entry = counts.get(key) ?? { adCount: 0, labeledCount: 0, activeCount: 0, winnerCount: 0 };
    entry.adCount++;
    if (row.hook_archetype) entry.labeledCount++;
    if (row.is_active) entry.activeCount++;
    if (evaluator.isWinner(row as unknown as WinnerEvalRow)) entry.winnerCount++;
    counts.set(key, entry);
  }

  return competitors.map((competitor) => {
    const status = latestSyncStatus.get(String(competitor.id));
    const syncing = status === 'pending' || status === 'processing';
    return {
      ...competitor,
      ...(counts.get(String(competitor.id)) ?? { adCount: 0, labeledCount: 0, activeCount: 0, winnerCount: 0 }),
      syncing,
      syncFailed: !syncing && status === 'failed' && !competitor.last_synced_at,
    };
  });
}

/** Win-score-ranked creatives returned (hero takes a slice, grid shows all). */
const GRID_LIMIT = 24;
/** Top semantic message-family clusters surfaced as "angles". */
const CLUSTER_LIMIT = 12;

/**
 * The Competitor Analysis dashboard entity (Adcero's dashboard route, REUSE
 * §5.5) over the non-self competitors' ads, optionally one competitor and/or
 * one platform. The return type is inferred on purpose: `EnrichedAd.angle` is
 * mistyped in the copied types (REUSE_MANIFEST §11.2), so annotating it as
 * `BrandIdentityDashboard` fails typecheck.
 */
export async function buildCompetitorDashboard(
  db: SupabaseClient,
  { competitorId, platform }: { competitorId?: string; platform: 'meta' | 'google' | 'all' }
) {
  const competitors = await loadTrackedCompetitors(db, { self: false });
  const ids = competitorId
    ? competitors.filter((c) => c.id === competitorId).map((c) => c.id)
    : competitors.map((c) => c.id);

  const rows = await fetchAllEnrichedAdRows<EnrichedAdRow>(db, {
    organizationId: ADLAB_ORG_ID,
    competitorIds: ids,
    platform,
  });
  const vectors = await loadAdVectors(
    db,
    ADLAB_ORG_ID,
    rows.map((row) => row.id)
  );
  const replication = computeReplication(rows, vectors, EMBEDDING_MODEL);

  const names = new Map<string, string>();
  const brandTypes = new Map<string, BrandType>();
  for (const c of competitors) {
    names.set(String(c.id), c.name ?? c.meta_page_name ?? 'Unknown');
    brandTypes.set(String(c.id), brandTypeOf(c));
  }

  const dashboard = buildDashboard(rows, replication, names, { gridLimit: GRID_LIMIT, clusterLimit: CLUSTER_LIMIT }, brandTypes);

  return {
    scope: {
      competitorId: competitorId ?? null,
      totalAds: rows.length,
      labeledAds: rows.filter((row) => row.hook_archetype !== null).length,
      activeAds: rows.filter((row) => row.is_active).length,
      provenWinners: dashboard.provenWinners,
      embeddedAds: vectors.size,
    },
    winners: dashboard.winners.map((w) => ({
      ad: serializeEnrichedAd(w.ad),
      winScore: w.winScore,
      replicationCount: w.replicationCount,
      reachAvailable: w.reachAvailable,
    })),
    overIndex: dashboard.overIndex,
    breakdowns: dashboard.breakdowns,
    mediaQuadrants: dashboard.mediaQuadrants,
    angleClusters: dashboard.angleClusters.map((cluster) => ({
      ...cluster,
      members: cluster.members.map((m) => ({ ad: serializeEnrichedAd(m.ad), winScore: m.winScore })),
    })),
    exampleAds: dashboard.exampleAds.map(serializeEnrichedAd),
  };
}

/**
 * Brand-object enqueue helpers — clone of the brand-presence queue contract:
 * a non-atomic find→insert probe backstopped by the partial unique index
 * idx_job_queue_brand_object_active_dedupe (migration 0132, 0115 pattern);
 * 23505 losers resolve to the winning row. Per-brand dedupe keys serialize
 * each job type per brand.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_OBJECT_CONFIG } from '@/lib/brand-object/config';
import { getBrandObjectState } from './state';
import {
  BRAND_OBJECT_CHUNKS_JOB_TYPE,
  BRAND_OBJECT_CRAWL_JOB_TYPE,
  BRAND_OBJECT_IDENTITY_JOB_TYPE,
  BRAND_OBJECT_MARKET_JOB_TYPE,
  BRAND_OBJECT_PERSONAS_JOB_TYPE,
  BRAND_OBJECT_PROMOTE_JOB_TYPE,
} from './types';

async function findActiveJob(
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

const ACTIVE_DEDUPE_INDEX = 'idx_job_queue_brand_object_active_dedupe';

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

export function enqueueBrandObjectPromote(
  supabase: SupabaseClient,
  params: { organizationId: string; brandProfileId: string; chain?: boolean },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_OBJECT_PROMOTE_JOB_TYPE,
    dedupeKey: `bo_promote:${params.brandProfileId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      chain: params.chain ?? false,
    },
  });
}

export function enqueueBrandObjectCrawl(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    force?: boolean;
    chain?: boolean;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_OBJECT_CRAWL_JOB_TYPE,
    dedupeKey: `bo_crawl:${params.brandProfileId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      force: params.force ?? false,
      chain: params.chain ?? false,
    },
  });
}

export function enqueueBrandObjectIdentity(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    crawlRefs: string[];
    chain?: boolean;
  },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_OBJECT_IDENTITY_JOB_TYPE,
    dedupeKey: `bo_identity:${params.brandProfileId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      crawlRefs: params.crawlRefs,
      chain: params.chain ?? false,
    },
  });
}

export function enqueueBrandObjectChunks(
  supabase: SupabaseClient,
  params: { organizationId: string; brandProfileId: string },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_OBJECT_CHUNKS_JOB_TYPE,
    dedupeKey: `bo_chunks:${params.brandProfileId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
    },
  });
}

export function enqueueBrandObjectMarket(
  supabase: SupabaseClient,
  params: { organizationId: string; brandProfileId: string; chain?: boolean },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_OBJECT_MARKET_JOB_TYPE,
    dedupeKey: `bo_market:${params.brandProfileId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      chain: params.chain ?? false,
    },
  });
}

export function enqueueBrandObjectPersonas(
  supabase: SupabaseClient,
  params: { organizationId: string; brandProfileId: string; chain?: boolean },
): Promise<{ jobId: string; deduped: boolean }> {
  return enqueue(supabase, {
    type: BRAND_OBJECT_PERSONAS_JOB_TYPE,
    dedupeKey: `bo_personas:${params.brandProfileId}`,
    organizationId: params.organizationId,
    payload: {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      chain: params.chain ?? false,
    },
  });
}

/**
 * The Layer-2 cluster-finalize hook. FAIL-SOFT and OPT-IN by design:
 *   - Layer 3 is opt-in per brand — no brand_object_state row means the
 *     founder never started a Brand Object build, so the hook does nothing.
 *   - A CHANGED cluster_run_id (the theme layer was genuinely rebuilt —
 *     cluster jobs are themselves threshold-gated upstream) always promotes:
 *     promote is zero-LLM, and gating it on the interval swallowed the
 *     first-harvest refresh (Bee Inspired 2026-07-16: a thin launch-time
 *     promote stamped lastRunAt, then the real 95-theme rebuild two hours
 *     later was silently blocked for 24h).
 *   - Same-run re-clusters stay threshold-gated: >= promotion.minNewPhrases
 *     phrases past the watermark AND >= promotion.minIntervalHours since the
 *     last promote.
 *   - Enqueues with chain:true so the refresh flows promote → market →
 *     personas → chunks, each stage's own fingerprint/cooldown/budget gates
 *     deciding real work (market usually fingerprint-skips on
 *     listening-only changes; personas is floor+fingerprint+cooldown+budget
 *     gated — at most one LLM call per brand per day).
 *   - A hook failure must NEVER fail the cluster job (caller wraps in
 *     try/catch; this helper also never throws).
 */
export async function maybeEnqueuePromoteAfterCluster(
  supabase: SupabaseClient,
  params: {
    organizationId: string;
    brandProfileId: string;
    clusterRunId: string;
  },
): Promise<void> {
  try {
    const state = await getBrandObjectState(
      supabase,
      params.organizationId,
      params.brandProfileId,
    );
    if (!state) return;

    const cfg = BRAND_OBJECT_CONFIG.promotion;
    const cursor = state.cursors?.promotion ?? {};
    const runChanged = cursor.clusterRunId !== params.clusterRunId;

    if (!runChanged) {
      const lastRunAt = cursor.lastRunAt ? Date.parse(cursor.lastRunAt) : 0;
      const intervalOk =
        Date.now() - lastRunAt >= cfg.minIntervalHours * 60 * 60 * 1000;
      if (!intervalOk) return;

      let enoughNewPhrases = false;
      if (cursor.phraseWatermark) {
        const { count, error } = await supabase
          .from('brand_presence_phrases')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', params.organizationId)
          .eq('brand_profile_id', params.brandProfileId)
          .gt('created_at', cursor.phraseWatermark);
        if (error) throw error;
        enoughNewPhrases = (count ?? 0) >= cfg.minNewPhrases;
      }
      if (!enoughNewPhrases) return;
    }

    const { jobId, deduped } = await enqueueBrandObjectPromote(supabase, {
      organizationId: params.organizationId,
      brandProfileId: params.brandProfileId,
      chain: true,
    });
    console.log(
      `[BrandObject] Promote ${deduped ? 'already queued' : 'queued'} (${jobId}) after cluster ${params.clusterRunId} for brand ${params.brandProfileId}`,
    );
  } catch (error) {
    console.warn(
      `[BrandObject] Post-cluster promote hook failed (non-fatal) for brand ${params.brandProfileId}`,
      error,
    );
  }
}

/**
 * The ad-library-finalize hook: competitor ad data changed, so re-derive the
 * market playbook for every opted-in brand whose distillation corpus could
 * include this competitor's ads. FAIL-SOFT and OPT-IN like the cluster hook:
 *   - No brand_object_state rows in the org → nobody opted in → no-op.
 *   - A brand qualifies when the competitor is in its active tag set, OR the
 *     brand has ZERO active tags (it distills the org-wide pool — the exact
 *     scoping loadLabeledAds uses in market-processor.ts).
 *   - Cheap by construction: bounded fan-out (brands per org are few), the
 *     bo_market:<profileId> dedupe collapses concurrent triggers, market is
 *     zero-LLM and fingerprint/cooldown-skips when the winner set is
 *     unchanged. chain:true lets personas/chunks follow behind their own
 *     gates.
 *   - Called from BOTH adlib seams (sync finalize + label-batch drain) since
 *     winner membership is longevity-gated (a zero-new-ads sync can still
 *     change the winner set) and label batches land asynchronously.
 */
export async function maybeEnqueueMarketAfterAdlibSync(
  supabase: SupabaseClient,
  params: { organizationId: string; competitorId: string },
): Promise<void> {
  try {
    const { data: states, error: statesError } = await supabase
      .from('brand_object_state')
      .select('brand_profile_id')
      .eq('organization_id', params.organizationId);
    if (statesError) throw statesError;
    const optedIn = (states ?? []).map((row) => String(row.brand_profile_id));
    if (optedIn.length === 0) return;

    const { data: tagged, error: taggedError } = await supabase
      .from('tracked_competitors')
      .select('id, brand_profile_id')
      .eq('organization_id', params.organizationId)
      .eq('status', 'active');
    if (taggedError) throw taggedError;
    const tagsByBrand = new Map<string, Set<string>>();
    for (const row of tagged ?? []) {
      if (!row.brand_profile_id) continue;
      const brandId = String(row.brand_profile_id);
      const set = tagsByBrand.get(brandId) ?? new Set<string>();
      set.add(String(row.id));
      tagsByBrand.set(brandId, set);
    }

    for (const brandProfileId of optedIn) {
      const tags = tagsByBrand.get(brandProfileId);
      const qualifies = tags
        ? tags.has(params.competitorId)
        : true; // zero tags → org-wide pool, any competitor's ads count
      if (!qualifies) continue;
      const { jobId, deduped } = await enqueueBrandObjectMarket(supabase, {
        organizationId: params.organizationId,
        brandProfileId,
        chain: true,
      });
      console.log(
        `[BrandObject] Market ${deduped ? 'already queued' : 'queued'} (${jobId}) after adlib data for brand ${brandProfileId}`,
      );
    }
  } catch (error) {
    console.warn(
      `[BrandObject] Post-adlib market hook failed (non-fatal) for competitor ${params.competitorId}`,
      error,
    );
  }
}

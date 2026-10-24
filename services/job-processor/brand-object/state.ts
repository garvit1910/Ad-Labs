/**
 * brand_object_state read/merge-write helpers. One row per brand profile:
 * status, per-section completeness, incremental job cursors, and the
 * monthly cost meter. Writes are read-merge-write at top-level-key
 * granularity — the per-brand job dedupe keys serialize each job type, and
 * different job types own DISJOINT cursor keys (promotion vs crawl vs
 * identity vs market vs personas), so concurrent writers never contend on
 * the same key. All queries are explicitly org+profile scoped (service role
 * bypasses RLS).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getBrandObjectMonthlyLlmCallCap } from '@/lib/brand-object/config';
import type { BrandObjectStatus, Completeness } from '@/lib/brand-object/types';

export interface PromotionCursor {
  clusterRunId?: string | null;
  /** created_at ISO of the newest phrase seen by the last promote. */
  phraseWatermark?: string | null;
  lastRunAt?: string | null;
}

export interface CrawlCursor {
  /** page url → sha256 of extracted text (unchanged pages skip identity). */
  pageHashes?: Record<string, string>;
  lastCrawledAt?: string | null;
}

export interface FingerprintCursor {
  packFingerprint?: string | null;
  lastRunAt?: string | null;
}

export interface BrandObjectCursors {
  promotion?: PromotionCursor;
  crawl?: CrawlCursor;
  identity?: FingerprintCursor;
  market?: FingerprintCursor;
  personas?: FingerprintCursor;
}

export interface MonthlyCost {
  llmCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  embedTokens?: number;
  apifyRuns?: number;
}

export interface BrandObjectStateRow {
  brand_profile_id: string;
  organization_id: string;
  status: BrandObjectStatus;
  completeness: Completeness | Record<string, never>;
  cursors: BrandObjectCursors;
  cost: Record<string, MonthlyCost>;
}

const STATE_COLUMNS =
  'brand_profile_id, organization_id, status, completeness, cursors, cost';

export async function getBrandObjectState(
  supabase: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
): Promise<BrandObjectStateRow | null> {
  const { data, error } = await supabase
    .from('brand_object_state')
    .select(STATE_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('brand_profile_id', brandProfileId)
    .maybeSingle();
  if (error) throw error;
  return (data as BrandObjectStateRow | null) ?? null;
}

/** Idempotent create-if-missing (23505 race resolves to the winner). */
export async function ensureBrandObjectState(
  supabase: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
): Promise<BrandObjectStateRow> {
  const existing = await getBrandObjectState(
    supabase,
    organizationId,
    brandProfileId,
  );
  if (existing) return existing;
  const { data, error } = await supabase
    .from('brand_object_state')
    .insert({
      brand_profile_id: brandProfileId,
      organization_id: organizationId,
    })
    .select(STATE_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const winner = await getBrandObjectState(
        supabase,
        organizationId,
        brandProfileId,
      );
      if (winner) return winner;
    }
    throw error;
  }
  return data as BrandObjectStateRow;
}

export interface StatePatch {
  status?: BrandObjectStatus;
  completeness?: Completeness;
  /** Merged at top-level cursor-key granularity. */
  cursors?: BrandObjectCursors;
}

/** Read-merge-write. Re-reads immediately before writing to keep the lost-
 * update window small; disjoint-key ownership (see module header) makes the
 * remaining window harmless. */
export async function mergeBrandObjectState(
  supabase: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
  patch: StatePatch,
): Promise<void> {
  const current = await ensureBrandObjectState(
    supabase,
    organizationId,
    brandProfileId,
  );
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.status) update.status = patch.status;
  if (patch.completeness) update.completeness = patch.completeness;
  if (patch.cursors) {
    update.cursors = { ...current.cursors, ...patch.cursors };
  }
  const { error } = await supabase
    .from('brand_object_state')
    .update(update)
    .eq('organization_id', organizationId)
    .eq('brand_profile_id', brandProfileId);
  if (error) throw error;
}

/** UTC month key for the cost meter. */
export function monthKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Thrown when the monthly LLM call cap is hit — an EXPECTED cost control,
 * not a failure. Processors mark it non-retryable (ingestion-budget
 * posture) so the job fails visibly instead of burning attempts. */
export class BrandObjectBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandObjectBudgetError';
  }
}

/** Call BEFORE every LLM call site. */
export function assertBrandObjectBudget(
  state: BrandObjectStateRow,
  now: Date = new Date(),
): void {
  const cap = getBrandObjectMonthlyLlmCallCap();
  const spent = state.cost?.[monthKey(now)]?.llmCalls ?? 0;
  if (spent >= cap) {
    throw new BrandObjectBudgetError(
      `Brand object monthly LLM call cap reached (${spent}/${cap}) for brand ` +
        `${state.brand_profile_id}. Raise BRAND_OBJECT_MONTHLY_LLM_CALL_CAP ` +
        `or wait for the next month window.`,
    );
  }
}

/** Accumulate usage into the current month bucket (read-merge-write). */
export async function recordBrandObjectUsage(
  supabase: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
  usage: MonthlyCost,
  now: Date = new Date(),
): Promise<void> {
  const current = await ensureBrandObjectState(
    supabase,
    organizationId,
    brandProfileId,
  );
  const key = monthKey(now);
  const month = current.cost?.[key] ?? {};
  const merged: MonthlyCost = {
    llmCalls: (month.llmCalls ?? 0) + (usage.llmCalls ?? 0),
    inputTokens: (month.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    outputTokens: (month.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    embedTokens: (month.embedTokens ?? 0) + (usage.embedTokens ?? 0),
    apifyRuns: (month.apifyRuns ?? 0) + (usage.apifyRuns ?? 0),
  };
  const { error } = await supabase
    .from('brand_object_state')
    .update({
      cost: { ...current.cost, [key]: merged },
      updated_at: now.toISOString(),
    })
    .eq('organization_id', organizationId)
    .eq('brand_profile_id', brandProfileId);
  if (error) throw error;
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AdLibraryProvider,
  NormalizedAd,
} from '@/services/ad-library/types';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../../function-timeout';
import type { CompetitorRow } from './types';
import { resolvePageIdentity } from './enrichment';

/**
 * Page-ID resolution fallback for handle-tracked Meta competitors whose
 * Facebook page is private/region-gated.
 *
 * The actor's page-URL mode scrapes `facebook.com/<handle>` directly, and a
 * restricted page shows it nothing ("Page is private") — a permanent zero,
 * because the meta_page_id backfill normally resolves FROM the scraped ads.
 * The Ad Library itself indexes ads by numeric Page ID regardless of page
 * privacy (verified live: jonesroadbeauty — restricted page, ~880 ads via
 * view_all_page_id), so when a handle scrape yields nothing we run one SMALL
 * keyword scrape of the handle through the same actor, match the returned
 * advertiser page names against the handle/competitor name, and backfill
 * meta_page_id. The provider prefers pageId over pageHandle, so every later
 * sync uses the privacy-immune view_all_page_id URL.
 *
 * Direct HTTP resolution is not an option: facebook.com and the Ad Library
 * typeahead both bot-wall plain server-side fetches (verified live), so the
 * Apify actor (residential proxies) is the only reliable resolver.
 */

/**
 * Small per-keyword scrape ceiling. The actor bills per result and enforces a
 * 10-result minimum; 30 keeps cost trivial while giving the brand's own ads
 * room to appear among loosely-matched keyword results.
 */
export const PAGE_ID_RESOLVE_AD_LIMIT = 30;

/**
 * Re-attempt window. A failed resolution is stamped on the competitor so
 * repeated zero-ad syncs (daily cron, "Sync now" clicks) don't re-bill a
 * resolution run more than once per window.
 */
export const PAGE_ID_RESOLVE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum remaining function budget before starting the blocking resolve
 * fetch. Typical keyword runs finish in 10-60s; pausing BEFORE the run starts
 * means a resume never orphans a billed run.
 */
const RESOLVE_MIN_BUDGET_MS = 120_000;

interface PageIdResolveStamp {
  attemptedAt: string;
  resolvedPageId: string | null;
}

/** Identity-comparison form: lowercase, alphanumerics only — "Jones Road Beauty" ≡ "jonesroadbeauty". */
export function normalizeIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when a zero-ad sync should attempt resolution: an Apify-scraped,
 * handle-tracked Meta competitor with no numeric id yet and no attempt inside
 * the retry window. Keyword competitors span many pages (nothing to resolve);
 * the mock provider must never trigger billable fallbacks.
 */
export function shouldAttemptPageIdResolution(
  competitor: CompetitorRow,
  provider: AdLibraryProvider
): boolean {
  if (provider.name !== 'apify') return false;
  if (competitor.platform === 'google') return false;
  if (competitor.keyword) return false;
  if (!competitor.page_ref) return false;
  if (competitor.meta_page_id) return false;
  const stamp = (competitor.scores ?? {}).pageIdResolve as
    | PageIdResolveStamp
    | undefined;
  if (stamp?.attemptedAt) {
    const age = Date.now() - Date.parse(stamp.attemptedAt);
    if (Number.isFinite(age) && age < PAGE_ID_RESOLVE_RETRY_MS) return false;
  }
  return true;
}

/**
 * The advertiser Page among keyword-scraped ads whose name matches one of the
 * identity candidates (handle / competitor name). Keyword results are loose —
 * resellers and unrelated brands ride along — so only exact normalized
 * page-name matches count, then the most frequent matching page wins.
 */
export function matchPageIdFromAds(
  ads: NormalizedAd[],
  candidates: Array<string | null | undefined>
): { pageId: string; pageName: string | null } | null {
  const targets = new Set(
    candidates
      .map((c) => (c ? normalizeIdentity(c) : ''))
      .filter((c) => c.length > 0)
  );
  if (targets.size === 0) return null;
  const matching = ads.filter(
    (ad) =>
      ad.pageId && ad.pageName && targets.has(normalizeIdentity(ad.pageName))
  );
  return resolvePageIdentity(matching);
}

/**
 * Runs the resolution scrape(s) and persists the outcome. Returns the resolved
 * Page ID (also written to tracked_competitors.meta_page_id) or null. The
 * attempt stamp lands in scores.pageIdResolve either way so the fallback can't
 * re-bill every sync. Provider errors propagate — the job retries and the
 * unstamped attempt re-runs against a cache-served (free) main fetch.
 */
export async function attemptPageIdResolution(params: {
  db: SupabaseClient;
  provider: AdLibraryProvider;
  competitor: CompetitorRow;
  signal?: AbortSignal;
  timeoutTracker?: FunctionTimeoutTracker;
}): Promise<string | null> {
  const { db, provider, competitor, signal, timeoutTracker } = params;

  if (
    timeoutTracker &&
    timeoutTracker.getRemainingMs() < RESOLVE_MIN_BUDGET_MS
  ) {
    throw new FunctionTimeoutError(
      'Function timeout - will resume on next cron'
    );
  }

  const handle = competitor.page_ref!;
  const candidates = [handle, competitor.name];
  // Search the handle first; a differently-named competitor gets one more try.
  const keywords = [handle];
  if (
    competitor.name &&
    normalizeIdentity(competitor.name) !== normalizeIdentity(handle)
  ) {
    keywords.push(competitor.name);
  }

  let match: { pageId: string; pageName: string | null } | null = null;
  for (const keyword of keywords) {
    console.log(
      `[AdLibSync] Competitor ${competitor.id}: resolving Page ID via keyword scrape "${keyword}"`
    );
    const result = await provider.fetchAds(
      { keyword, country: competitor.country ?? undefined },
      { limit: PAGE_ID_RESOLVE_AD_LIMIT, signal }
    );
    match = matchPageIdFromAds(result.ads, candidates);
    if (match) break;
  }

  // Persist the outcome (attempt stamp always; identity on success) in one
  // merge-safe update. Best-effort, like backfillPageIdentity — a write
  // failure still lets THIS job's retry fetch proceed with the in-memory id.
  const nowIso = new Date().toISOString();
  const stamp: PageIdResolveStamp = {
    attemptedAt: nowIso,
    resolvedPageId: match?.pageId ?? null,
  };
  const { data: current } = await db
    .from('tracked_competitors')
    .select('scores')
    .eq('id', competitor.id)
    .maybeSingle<{ scores: Record<string, unknown> | null }>();
  const scores = (current?.scores ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {
    scores: { ...scores, pageIdResolve: stamp },
    updated_at: nowIso,
  };
  if (match) {
    updates.meta_page_id = match.pageId;
    if (match.pageName) {
      updates.meta_page_name = match.pageName;
      // Replace the auto-default name (the raw handle) with the brand name.
      if (!competitor.name || competitor.name === competitor.page_ref) {
        updates.name = match.pageName;
      }
    }
  }
  const { error } = await db
    .from('tracked_competitors')
    .update(updates)
    .eq('id', competitor.id);
  if (error) {
    console.warn(
      `[AdLibSync] Failed to persist page-id resolution for ${competitor.id}: ${error.message}`
    );
  }

  console.log(
    match
      ? `[AdLibSync] Competitor ${competitor.id}: resolved Page ID ${match.pageId} (${match.pageName ?? 'unnamed'})`
      : `[AdLibSync] Competitor ${competitor.id}: page-id resolution found no matching advertiser`
  );
  return match?.pageId ?? null;
}

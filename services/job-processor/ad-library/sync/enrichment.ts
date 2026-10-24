import type { SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedAd } from '@/services/ad-library/types';
import {
  suggestBrandType,
  type BrandTypeSignals,
} from '@/lib/brand-identity/brand-type-classifier';
import { suggestIndustry } from '@/lib/brand-identity/industry-classifier';
import { INDUSTRY_CATALOG_ORG_ID } from '@/lib/brand-identity/industries';
import type { CompetitorRow } from './types';

/** Ads sampled (with the brand name) to classify a competitor's industry. */
const INDUSTRY_CLASSIFY_SAMPLE = 25;

const DAY_MS = 86_400_000;

/** Derives advisory brand-type signals from a competitor's scraped ad corpus. */
export function deriveBrandTypeSignals(
  ads: NormalizedAd[],
  nowIso: string
): BrandTypeSignals {
  const adCount = ads.length;
  if (adCount === 0) {
    return { adCount: 0, activeRatio: 0, videoShare: 0, textShare: 0, medianLongevityDays: 0 };
  }
  const now = Date.parse(nowIso);
  let active = 0;
  let video = 0;
  let text = 0;
  const spans: number[] = [];
  for (const ad of ads) {
    if (ad.deliveryStop == null) active++;
    if (ad.mediaType === 'video') video++;
    if (ad.mediaType === 'text') text++;
    if (ad.numServedDays != null) {
      spans.push(ad.numServedDays);
    } else {
      const start = Date.parse(ad.deliveryStart);
      const stop = ad.deliveryStop ? Date.parse(ad.deliveryStop) : now;
      spans.push(Math.max(0, (stop - start) / DAY_MS));
    }
  }
  spans.sort((a, b) => a - b);
  const mid = Math.floor(spans.length / 2);
  const medianLongevityDays =
    spans.length % 2 === 0 ? (spans[mid - 1] + spans[mid]) / 2 : spans[mid];
  return {
    adCount,
    activeRatio: active / adCount,
    videoShare: video / adCount,
    textShare: text / adCount,
    medianLongevityDays,
  };
}

/** The advertiser Page that most of the scraped ads belong to. */
export function resolvePageIdentity(
  ads: NormalizedAd[]
): { pageId: string; pageName: string | null } | null {
  const counts = new Map<string, { count: number; name: string | null }>();
  for (const ad of ads) {
    if (!ad.pageId) continue;
    const entry = counts.get(ad.pageId) ?? { count: 0, name: ad.pageName };
    entry.count++;
    if (!entry.name && ad.pageName) entry.name = ad.pageName;
    counts.set(ad.pageId, entry);
  }
  let best: { pageId: string; pageName: string | null } | null = null;
  let bestCount = 0;
  for (const [pageId, entry] of counts) {
    if (entry.count > bestCount) {
      best = { pageId, pageName: entry.name };
      bestCount = entry.count;
    }
  }
  return best;
}

/** Dispatches advertiser-identity backfill by platform. */
export async function backfillIdentity(
  db: SupabaseClient,
  competitor: CompetitorRow,
  ads: NormalizedAd[]
): Promise<void> {
  if (competitor.platform === 'google') {
    await backfillGoogleIdentity(db, competitor, ads);
  } else {
    await backfillPageIdentity(db, competitor, ads);
  }
}

/**
 * Resolves the advertiser's Page ID + brand name from the scraped ads and
 * backfills a page-tracked competitor — so a handle/URL the user pasted
 * becomes the real Page ID and display name. Best-effort; a meta_page_id
 * unique collision (page already tracked) is logged, not fatal.
 */
async function backfillPageIdentity(
  db: SupabaseClient,
  competitor: CompetitorRow,
  ads: NormalizedAd[]
): Promise<void> {
  // Only for page-tracked competitors; keyword searches span many pages.
  if (competitor.keyword) return;
  if (!competitor.page_ref && !competitor.meta_page_id) return;

  const identity = resolvePageIdentity(ads);
  if (!identity?.pageId) return;

  const updates: Record<string, string> = {};
  if (!competitor.meta_page_id) updates.meta_page_id = identity.pageId;
  if (identity.pageName) {
    updates.meta_page_name = identity.pageName;
    // Replace the auto-default name (the raw handle) with the brand name.
    if (!competitor.name || competitor.name === competitor.page_ref) {
      updates.name = identity.pageName;
    }
  }
  if (Object.keys(updates).length === 0) return;
  updates.updated_at = new Date().toISOString();

  const { error } = await db
    .from('tracked_competitors')
    .update(updates)
    .eq('id', competitor.id);
  if (error) {
    console.warn(
      `[AdLibSync] Failed to backfill page identity for ${competitor.id}: ${error.message}`
    );
  }
}

/**
 * Resolves the Google advertiser's display name from the scraped ads and
 * backfills it onto the competitor (the AR id is already known from the
 * pasted URL). Best-effort; mirrors backfillPageIdentity.
 */
async function backfillGoogleIdentity(
  db: SupabaseClient,
  competitor: CompetitorRow,
  ads: NormalizedAd[]
): Promise<void> {
  if (competitor.google_advertiser_name) return;

  // Google ads carry the advertiser id/name on pageId/pageName.
  const identity = resolvePageIdentity(ads);
  if (!identity?.pageName) return;

  const updates: Record<string, string> = {
    google_advertiser_name: identity.pageName,
    updated_at: new Date().toISOString(),
  };
  // Replace the auto-default name (the raw AR id) with the advertiser name.
  if (!competitor.name || competitor.name === competitor.google_advertiser_id) {
    updates.name = identity.pageName;
  }

  const { error } = await db
    .from('tracked_competitors')
    .update(updates)
    .eq('id', competitor.id);
  if (error) {
    console.warn(
      `[AdLibSync] Failed to backfill Google identity for ${competitor.id}: ${error.message}`
    );
  }
}

/**
 * Computes an ADVISORY brand-type suggestion from the scraped corpus and
 * merges it into tracked_competitors.scores.brandTypeSuggestion for human
 * review. Best-effort; never writes the brand_type column (which a human owns).
 */
export async function persistBrandTypeSuggestion(
  db: SupabaseClient,
  competitor: CompetitorRow,
  ads: NormalizedAd[],
  syncIso: string
): Promise<void> {
  try {
    const signals = deriveBrandTypeSignals(ads, syncIso);
    const suggestion = suggestBrandType(signals);
    const { data: current } = await db
      .from('tracked_competitors')
      .select('scores')
      .eq('id', competitor.id)
      .maybeSingle();
    const scores = (current?.scores ?? {}) as Record<string, unknown>;
    const { error } = await db
      .from('tracked_competitors')
      .update({
        scores: {
          ...scores,
          brandTypeSuggestion: { ...suggestion, signals, suggestedAt: syncIso },
        },
        updated_at: syncIso,
      })
      .eq('id', competitor.id);
    if (error) throw error;
  } catch (error) {
    console.warn(
      `[AdLibSync] Failed to persist brand-type suggestion for ${competitor.id}: ${
        (error as Error).message
      }`
    );
  }
}

/** Dominant-domain gate: the mode must cover this share of domain-bearing ads. */
const LANDING_DOMAIN_MIN_SHARE = 0.5;
/** ...and be backed by at least this many ads (keyword searches span brands). */
const LANDING_DOMAIN_MIN_ADS = 3;

/**
 * Computes the competitor's dominant landing domain over its stored ads and
 * merges it into tracked_competitors.scores.landingDomain — the deterministic
 * key pairCompetitorsByBrand uses to link the Meta and Google rows of one
 * real-world brand. An ambiguous corpus (mode below the share/count gate)
 * CLEARS the key: a stale confident domain would fabricate pairs. Best-effort;
 * mirrors persistBrandTypeSuggestion's read-modify-write merge.
 */
export async function persistLandingDomainScore(
  db: SupabaseClient,
  organizationId: string,
  competitorId: string,
  syncIso: string
): Promise<void> {
  try {
    const { data: ads, error: adsError } = await db
      .from('library_ads')
      .select('landing_domain')
      .eq('organization_id', organizationId)
      .eq('competitor_id', competitorId)
      .not('landing_domain', 'is', null);
    if (adsError) throw adsError;

    const counts = new Map<string, number>();
    for (const row of (ads ?? []) as Array<{ landing_domain: string | null }>) {
      if (!row.landing_domain) continue;
      counts.set(row.landing_domain, (counts.get(row.landing_domain) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    let total = 0;
    for (const [domain, count] of counts) {
      total += count;
      if (count > bestCount) {
        best = domain;
        bestCount = count;
      }
    }
    const share = total > 0 ? bestCount / total : 0;
    const qualifies =
      best !== null &&
      bestCount >= LANDING_DOMAIN_MIN_ADS &&
      share >= LANDING_DOMAIN_MIN_SHARE;

    const { data: current, error: readError } = await db
      .from('tracked_competitors')
      .select('scores')
      .eq('id', competitorId)
      .maybeSingle();
    // Loud-fail on the pre-read: merging onto {} would wipe sibling keys
    // (competitor-update-scores-guard regression).
    if (readError) throw readError;
    const scores = (current?.scores ?? {}) as Record<string, unknown>;
    if (!qualifies && scores.landingDomain === undefined) return;

    const nextScores: Record<string, unknown> = { ...scores };
    if (qualifies) {
      nextScores.landingDomain = {
        domain: best,
        share: Number(share.toFixed(3)),
        adCount: total,
        computedAt: syncIso,
      };
    } else {
      delete nextScores.landingDomain;
    }
    const { error } = await db
      .from('tracked_competitors')
      .update({ scores: nextScores, updated_at: syncIso })
      .eq('id', competitorId);
    if (error) throw error;
  } catch (error) {
    console.warn(
      `[AdLibSync] Failed to persist landing domain for ${competitorId}: ${
        (error as Error).message
      }`
    );
  }
}

/**
 * Classifies the competitor into one of the 16 industries from its page name +
 * ad copy and AUTO-APPLIES it to the `industry` column so the labelling
 * pipeline picks that industry's angle vocabulary. Confidence-gated (a weak
 * result leaves `industry` null → universal angles). Best-effort; never throws.
 *
 * Skips when: the competitor is an Industry Explorer catalog seed (owned by the
 * sentinel org — its industry comes from seeding), `industry` is already set,
 * or a human override is recorded in scores.industryOverride.
 */
export async function persistIndustryClassification(
  db: SupabaseClient,
  organizationId: string,
  competitorId: string,
  syncIso: string,
  signal: AbortSignal
): Promise<void> {
  try {
    const { data: competitor } = await db
      .from('tracked_competitors')
      .select('id, organization_id, name, industry, scores')
      .eq('id', competitorId)
      .eq('organization_id', organizationId)
      .maybeSingle<{
        id: string;
        organization_id: string;
        name: string | null;
        industry: string | null;
        scores: Record<string, unknown> | null;
      }>();
    if (!competitor) return;
    // Catalog seeds get their industry from seeding; never reclassify them.
    if (competitor.organization_id === INDUSTRY_CATALOG_ORG_ID) return;
    // Already classified, or a human pinned it — don't stomp.
    if (competitor.industry) return;
    const scores = (competitor.scores ?? {}) as Record<string, unknown>;
    if (scores.industryOverride === true) return;

    // Read a sample of this competitor's synced ads for the classifier.
    const { data: ads } = await db
      .from('library_ads')
      .select('page_name, creative_bodies')
      .eq('organization_id', organizationId)
      .eq('competitor_id', competitorId)
      .limit(INDUSTRY_CLASSIFY_SAMPLE);
    const sample = (ads ?? []) as Array<{
      page_name: string | null;
      creative_bodies: string[] | null;
    }>;
    const pageName =
      competitor.name ?? sample.find((a) => a.page_name)?.page_name ?? null;
    const adCopyCorpus = sample.flatMap((a) => a.creative_bodies ?? []);

    const suggestion = await suggestIndustry(
      { pageName, adCopyCorpus },
      { signal }
    );

    const updates: Record<string, unknown> = {
      scores: {
        ...scores,
        industryClassification: { ...suggestion, classifiedAt: syncIso },
      },
      updated_at: syncIso,
    };
    // Auto-apply only a confident, known classification.
    if (suggestion.industry) updates.industry = suggestion.industry;

    const { error } = await db
      .from('tracked_competitors')
      .update(updates)
      .eq('id', competitorId);
    if (error) throw error;
  } catch (error) {
    console.warn(
      `[AdLibSync] Failed to classify industry for ${competitorId}: ${
        (error as Error).message
      }`
    );
  }
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchWebsiteContent } from '@/lib/brand-summary/fetch-website';
import { assertPublicHttpUrl } from '@/services/ad-library/website-facebook-resolver';
import {
  extractBrandProfile,
  domainVariant,
  type ExtractedBrandProfile,
} from '@/lib/brand-presence/discover-profile';
import { LlmProviderError } from '@/lib/llm/errors';
import { WebsiteApifyProvider } from '@/services/brand-presence/website-apify-provider';
import { COMING_SOON_SOURCE_TYPES } from '@/lib/brand-presence/types';
import type { Job } from '../types';
import { brandPresenceDiscoverPayloadSchema } from './types';

/**
 * A challenge/block page strips down to almost nothing; treat text below this
 * as "unreadable" and worth the Apify fallback (or a degraded draft).
 */
const READABLE_MIN_CHARS = 200;

/**
 * brand_presence_discover — website URL -> draft brand_presence_profiles row
 * + seeded brand_presence_sources rows. Multi-brand: an org can have many
 * profiles. Idempotency is keyed on (org, website_url): re-running the same URL
 * reuses/updates its DRAFT profile (a confirmed profile for that URL is never
 * stomped and re-discovery is a no-op), while a NEW URL always creates a new
 * brand. Seed sources upsert on (brand_profile_id, source_type, uri). The
 * founder confirms/edits the draft in the UI before any scraping.
 */
export class BrandPresenceDiscoverProcessor {
  constructor(
    private readonly _db: SupabaseClient,
    // Injectable for tests; production lazily constructs one only when the
    // plain fetch is blocked and an APIFY_TOKEN is configured.
    private readonly websiteProvider?: WebsiteApifyProvider,
  ) {}

  async process(job: Job, signal: AbortSignal): Promise<void> {
    const payload = brandPresenceDiscoverPayloadSchema.parse(job.payload);
    const { organizationId, websiteUrl, presenceRole } = payload;

    // Defense-in-depth: the route already SSRF-guards, but the worker must
    // never fetch a private/internal origin either.
    const url = assertPublicHttpUrl(websiteUrl);

    // A profile for THIS URL in this org: reuse a draft, skip if confirmed.
    // Other brands (other URLs) are untouched.
    const { data: existing, error: existingError } = await this._db
      .from('brand_presence_profiles')
      .select('id, status, meta')
      .eq('organization_id', organizationId)
      .eq('website_url', url.toString())
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing && existing.status === 'confirmed') {
      console.log(
        `[BrandPresence] Org ${organizationId} already has a confirmed profile for ${url.toString()}, skipping re-discovery`,
      );
      return;
    }
    const existingDraftId = existing ? String(existing.id) : null;

    // Cheap plain fetch first, Apify residential-proxy fallback for
    // bot-blocked sites (hims.com/onbuy.com return 403 to server fetches), and
    // a graceful degrade so a blocked homepage never dead-ends the founder.
    const homepageText = await this.resolveHomepageText(url.toString(), signal);
    const homepageBlocked =
      !homepageText || homepageText.length < READABLE_MIN_CHARS;
    const extracted: ExtractedBrandProfile = homepageBlocked
      ? buildDegradedProfile(url.toString())
      : await extractProfileWithClassifiedErrors(homepageText, url.toString(), {
          signal,
        });

    // Seed competitors from the Layer-1 competitor set when one exists
    // (read-only — Layer 1 is untouched), merged with the LLM candidates.
    // The org scope alone excludes Industry Explorer catalog seeds (they are
    // owned by INDUSTRY_CATALOG_ORG_ID). Never filter on `industry` here: real
    // user-tracked competitors carry an auto-applied industry classification
    // too, so an `industry IS NULL` filter drops every classified competitor.
    const { data: tracked, error: trackedError } = await this._db
      .from('tracked_competitors')
      .select('name')
      .eq('organization_id', organizationId)
      .eq('status', 'active');
    if (trackedError) throw trackedError;
    const competitors = mergeCompetitors(
      (tracked ?? []).map((row) => String(row.name)),
      extracted.competitor_candidates,
    );

    // Merge the homepage-blocked flag into meta without stomping any existing
    // checkpoint state (e.g. subredditDiscovery). A successful re-run clears it.
    const existingMeta = (existing?.meta ?? {}) as Record<string, unknown>;
    const existingDiscovery = (existingMeta.discovery ?? {}) as Record<
      string,
      unknown
    >;
    const meta = {
      ...existingMeta,
      discovery: { ...existingDiscovery, homepageBlocked: homepageBlocked },
    };

    const nowIso = new Date().toISOString();
    const profileFields = {
      website_url: url.toString(),
      brand_name: extracted.brand_name,
      name_variants: extracted.name_variants,
      product_description: extracted.product_description,
      category: extracted.category,
      competitors,
      status: 'draft',
      meta,
      // Stamp the Brand Presence role (own vs competitor) when the enqueue
      // resolved one. Omitted for legacy job rows so a re-run never nulls an
      // existing role.
      ...(presenceRole ? { presence_role: presenceRole } : {}),
      updated_at: nowIso,
    };
    // Reuse the existing draft for this URL (idempotent re-run), else insert a
    // new brand. No org-conflict upsert — that would stomp a sibling brand.
    const profileQuery = existingDraftId
      ? this._db
          .from('brand_presence_profiles')
          .update(profileFields)
          .eq('id', existingDraftId)
          .eq('organization_id', organizationId)
          .select('id')
          .single()
      : this._db
          .from('brand_presence_profiles')
          .insert({ organization_id: organizationId, ...profileFields })
          .select('id')
          .single();
    const { data: profile, error: profileError } = await profileQuery;
    if (profileError || !profile) {
      throw profileError ?? new Error('Failed to save brand presence profile');
    }
    const brandProfileId = String(profile.id);

    // Seed the source registry rows: the two live search-based Reddit sources
    // (scraped after the founder confirms) + one coming_soon placeholder per
    // future source type (drives the card grid scaffolding).
    const seedRows = [
      {
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        source_type: 'reddit_search',
        uri: '',
        label: 'Reddit — brand mentions',
        status: 'pending',
        updated_at: nowIso,
      },
      {
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        source_type: 'reddit_category',
        uri: '',
        label: 'Reddit — category listening',
        status: 'pending',
        updated_at: nowIso,
      },
      // Live but founder-configured: stays 'available' until the founder
      // pastes their storefront/product URLs (amazon/setup flips it).
      {
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        source_type: 'amazon_reviews',
        uri: '',
        label: 'Amazon Reviews',
        status: 'available',
        updated_at: nowIso,
      },
      // Live but founder-configured: stays 'available' until the founder
      // pastes their Maps listing URL (google-maps/setup flips it).
      {
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        source_type: 'google_maps_reviews',
        uri: '',
        label: 'Google Maps reviews',
        status: 'available',
        updated_at: nowIso,
      },
      // Live but founder-configured: stays 'available' until the founder
      // confirms the brand handle (x/setup flips it).
      {
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        source_type: 'x',
        uri: '',
        label: 'X (Twitter)',
        status: 'available',
        updated_at: nowIso,
      },
      // Live but founder-configured: stays 'available' until the founder
      // confirms their Trustpilot page (trustpilot/setup flips it).
      {
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        source_type: 'trustpilot',
        uri: '',
        label: 'Trustpilot',
        status: 'available',
        updated_at: nowIso,
      },
      // Live but founder-configured: stays 'available' until the founder
      // submits their own profile (tiktok/setup flips it).
      {
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        source_type: 'tiktok_comments',
        uri: '',
        label: 'TikTok comments',
        status: 'available',
        updated_at: nowIso,
      },
      // Live but founder-configured: stays 'available' until the founder
      // submits their own profile (instagram/setup flips it).
      {
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        source_type: 'instagram_comments',
        uri: '',
        label: 'Instagram comments',
        status: 'available',
        updated_at: nowIso,
      },
      ...COMING_SOON_SOURCE_TYPES.map((sourceType) => ({
        organization_id: organizationId,
        brand_profile_id: brandProfileId,
        source_type: sourceType,
        uri: '',
        label: null,
        status: 'coming_soon',
        updated_at: nowIso,
      })),
    ];
    const { error: seedError } = await this._db
      .from('brand_presence_sources')
      .upsert(seedRows, {
        onConflict: 'brand_profile_id,source_type,uri',
        // Re-discovery must not reset the status/meta of sources that already
        // ran (e.g. a pending->synced reddit_search from an earlier draft).
        ignoreDuplicates: true,
      });
    if (seedError) throw seedError;

    console.log(
      `[BrandPresence] Discovered profile ${brandProfileId} for org ${organizationId} (${extracted.brand_name}, ${extracted.name_variants.length} variants, ${competitors.length} competitors)${homepageBlocked ? ' [homepage blocked — degraded draft]' : ''}`,
    );
  }

  /**
   * Homepage text via the cheap plain fetch, falling back to the Apify
   * residential-proxy crawler when the site blocks server-side requests
   * (403 / bot challenge). Returns thin-or-null text when everything fails —
   * the caller treats that as "blocked" and degrades gracefully rather than
   * failing the job.
   */
  private async resolveHomepageText(
    url: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    let text: string | null = null;
    try {
      text = await fetchWebsiteContent(url);
    } catch (error) {
      console.log(
        `[BrandPresence] Plain homepage fetch failed for ${url}:`,
        error instanceof Error ? error.message : error,
      );
    }
    if (text && text.length >= READABLE_MIN_CHARS) return text;

    // Only attempt Apify when we can (token configured, or a test injected a
    // provider). A blocked/thin plain fetch is the trigger.
    const canFallback =
      this.websiteProvider || Boolean(process.env.APIFY_TOKEN?.trim());
    if (canFallback) {
      try {
        const provider = this.websiteProvider ?? new WebsiteApifyProvider();
        const apifyText = await provider.fetchHomepageText(url, { signal });
        if (apifyText && apifyText.length >= READABLE_MIN_CHARS) return apifyText;
        console.log(
          `[BrandPresence] Apify homepage fallback returned thin content for ${url}`,
        );
      } catch (error) {
        console.log(
          `[BrandPresence] Apify homepage fallback failed for ${url}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return text;
  }
}

/**
 * The LLM extraction rethrown with a human-readable message. The executor
 * stores the thrown message as `job_queue.error_message`, which the wizard's
 * StepConfirm now surfaces verbatim — a raw provider payload ("insufficient_
 * quota" JSON) would be user-facing gibberish, so classified provider errors
 * are reformatted as reason + remediation. Retry semantics are unchanged: the
 * job still fails after max_attempts and the wizard's Retry re-enqueues.
 */
async function extractProfileWithClassifiedErrors(
  homepageText: string,
  websiteUrl: string,
  options: { signal: AbortSignal },
): Promise<ExtractedBrandProfile> {
  try {
    return await extractBrandProfile(homepageText, websiteUrl, options);
  } catch (error) {
    if (error instanceof LlmProviderError) {
      throw new Error(
        `Brand analysis failed — ${error.message}. ${error.remediation}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * A minimal draft when the homepage is unreadable — seeded from the domain so
 * the founder has something to edit/confirm instead of a hard failure. The
 * confirm card surfaces the `homepageBlocked` flag and prompts manual entry.
 */
function buildDegradedProfile(websiteUrl: string): ExtractedBrandProfile {
  const stem = domainVariant(websiteUrl);
  const brandName = stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : '';
  return {
    brand_name: brandName || websiteUrl,
    name_variants: stem ? [brandName, stem] : [],
    product_description: '',
    category: '',
    competitor_candidates: [],
  };
}

/** Layer-1 tracked competitor names first, then LLM candidates, deduped. */
function mergeCompetitors(tracked: string[], candidates: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...tracked, ...candidates]) {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === '' || seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged;
}

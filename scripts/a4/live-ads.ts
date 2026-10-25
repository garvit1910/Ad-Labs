import type { SupabaseClient } from '@supabase/supabase-js';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { firstRealBody } from '@/lib/brand-identity/creative-text';
import type { BrandType } from '@/lib/brand-identity/win-profile';
import { slugify } from '@/lib/creative-engine/brand-context/ingest';
import { CONTROL_ARM_ID, brandIdFor } from './vocabulary';

/*
 * The scraped Meta ads (A2), and the live-ad creative rows built from them
 * (docs/PLAN.md "A4", live ads to creative rows).
 */

export interface Page {
  id: string;
  name: string;
  brandId: string;
  isSelf: boolean;
  brandType: BrandType;
}

/** One labelled ad from library_ads_enriched, with the columns A4 reads. */
export interface LabelledAd {
  id: string;
  competitor_id: string;
  external_ad_id: string;
  platform: string;
  media_type: string | null;
  is_active: boolean;
  longevity_days: number;
  num_served_days: number | null;
  eu_total_reach: number | null;
  angle: string | null;
  hook_archetype: string | null;
  creative_bodies: string[] | null;
  creative_link_titles: string[] | null;
  media_urls: string[] | null;
  hook_text: string | null;
  summary: string | null;
  fingerprint: Record<string, unknown> | null;
}

const AD_COLUMNS =
  'id, competitor_id, external_ad_id, platform, media_type, is_active, longevity_days, num_served_days, eu_total_reach, angle, hook_archetype, creative_bodies, creative_link_titles, media_urls, hook_text, summary, fingerprint';
const PAGE_SIZE = 1000;

/** The brand's tracked Meta pages (its own and the competitors') and their labelled ads. */
export async function loadAds(db: SupabaseClient, brandProfileId: string): Promise<{ pages: Page[]; ads: LabelledAd[] }> {
  const { data: pageRows, error } = await db
    .from('tracked_competitors')
    .select('id, name, is_brand_self, brand_type')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('brand_profile_id', brandProfileId)
    .eq('platform', 'meta')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;
  const pages: Page[] = (pageRows ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    brandId: brandIdFor(String(row.name)),
    isSelf: Boolean(row.is_brand_self),
    brandType: (row.brand_type as BrandType | null) ?? 'unknown',
  }));

  // PostgREST caps a response at 1,000 rows, so page in id order (as market-processor.ts does).
  const ads: LabelledAd[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error: adError } = await db
      .from('library_ads_enriched')
      .select(AD_COLUMNS)
      .eq('organization_id', ADLAB_ORG_ID)
      .in('competitor_id', pages.map((page) => page.id))
      .not('hook_archetype', 'is', null)
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (adError) throw adError;
    for (const row of (data ?? []) as unknown as LabelledAd[]) {
      ads.push({ ...row, longevity_days: Number(row.longevity_days ?? 0), is_active: Boolean(row.is_active) });
    }
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  return { pages, ads };
}

export interface CreativeRow {
  creative_id: string;
  arm_id: string;
  brand_id: string;
  origin: string;
  headline: string;
  primary_text: string;
  cta: string;
  visual_description: string;
  image_url: string;
  landing_product_id: string;
  days_running: number;
  round_created: number;
  learning_ids: string;
  segment_id: string;
  pack_fingerprint: string;
  status: string;
}

export interface LiveCreatives {
  rows: CreativeRow[];
  /** Every ad that has a creative row, including collapsed copies (→ the kept copy's id). */
  creativeIdForAd: Map<string, string>;
  /** Per brand: ads, ads with body text, rows written. */
  counts: Map<string, { ads: number; withBody: number; rows: number }>;
}

const DEFAULT_CTA = 'Shop Now'; // Adcero doesn't store the CTA
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

function firstSentence(text: string): string {
  const sentence = text.split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? text;
  return sentence.length > 120 ? `${sentence.slice(0, 119)}…` : sentence;
}

/** Active ads first, then the longest-running, then id: the order rows are kept and listed in. */
const compareLive = (a: LabelledAd, b: LabelledAd) =>
  Number(b.is_active) - Number(a.is_active) || b.longevity_days - a.longevity_days || a.id.localeCompare(b.id);

/**
 * Ads with body text become creative rows, competitor_live or (Magic Spoon's own
 * page) brand_live in the control arm. Exact copies (same brand, headline and body)
 * collapse onto one row: the sim reads only text, so a copy is the same ad twice.
 */
export function buildLiveCreatives(pages: Page[], ads: LabelledAd[], landingProductId: string): LiveCreatives {
  const pageOf = new Map(pages.map((page) => [page.id, page]));
  const rows: CreativeRow[] = [];
  const creativeIdForAd = new Map<string, string>();
  const counts = new Map<string, { ads: number; withBody: number; rows: number }>(pages.map((page) => [page.brandId, { ads: 0, withBody: 0, rows: 0 }]));
  const kept = new Map<string, string>();

  for (const ad of [...ads].sort(compareLive)) {
    const page = pageOf.get(ad.competitor_id);
    if (!page) continue;
    const count = counts.get(page.brandId)!;
    count.ads++;
    const body = firstRealBody(ad.creative_bodies);
    if (!body) continue;
    count.withBody++;
    const headline = firstRealBody(ad.creative_link_titles) || ad.hook_text?.trim() || firstSentence(body);
    const copyKey = `${page.brandId}\n${normalize(headline)}\n${normalize(body)}`;
    const copyOf = kept.get(copyKey);
    if (copyOf) {
      creativeIdForAd.set(ad.id, copyOf);
      continue;
    }
    const creativeId = `cr_live_${slugify(page.name)}_${slugify(ad.external_ad_id)}`;
    const visualHook = typeof ad.fingerprint?.visual_hook === 'string' ? ad.fingerprint.visual_hook : '';
    const image = ad.media_urls?.[0] ?? '';
    rows.push({
      creative_id: creativeId,
      arm_id: page.isSelf ? CONTROL_ARM_ID : '',
      brand_id: page.brandId,
      origin: page.isSelf ? 'brand_live' : 'competitor_live',
      headline,
      primary_text: body,
      cta: DEFAULT_CTA,
      visual_description: [ad.summary?.trim(), visualHook.trim()].filter(Boolean).join(' '),
      image_url: /^https?:\/\/\S+$/.test(image) ? image : '',
      landing_product_id: page.isSelf ? landingProductId : '',
      days_running: Math.max(0, Math.round(ad.longevity_days)),
      round_created: 0,
      learning_ids: '[]',
      segment_id: '',
      pack_fingerprint: '',
      status: 'ranked',
    });
    kept.set(copyKey, creativeId);
    creativeIdForAd.set(ad.id, creativeId);
    count.rows++;
  }
  return { rows, creativeIdForAd, counts };
}

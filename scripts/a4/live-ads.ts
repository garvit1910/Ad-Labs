import type { SupabaseClient } from '@supabase/supabase-js';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { feedHeadline, feedImage, feedPrimary, flat } from '@/lib/adlab/sim-text';
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
  delivery_start: string | null;
  delivery_stop: string | null;
  last_seen_at: string | null;
}

const AD_COLUMNS =
  'id, competitor_id, external_ad_id, platform, media_type, is_active, longevity_days, num_served_days, eu_total_reach, angle, hook_archetype, creative_bodies, creative_link_titles, media_urls, hook_text, summary, fingerprint, delivery_start, delivery_stop, last_seen_at';
const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;
/** library_ads_enriched counts an ad without a stop date as running while it was seen in the last 32 days. */
const ACTIVE_WINDOW_MS = 32 * DAY_MS;

/**
 * The view's longevity_days and is_active, computed against `asOf` instead of now(),
 * with the view's own formula (supabase/migrations/0002). Pinned to the last scrape,
 * a rerun hours later builds the same rows instead of drifting every live ad's
 * days_running and the longevity-based recipe picks.
 */
function pinLongevity(ad: LabelledAd, asOf: number): Pick<LabelledAd, 'longevity_days' | 'is_active'> {
  const start = ad.delivery_start ? Date.parse(ad.delivery_start) : Number.NaN;
  if (!Number.isFinite(start)) return { longevity_days: ad.longevity_days, is_active: ad.is_active };
  const lastSeen = ad.last_seen_at ? Date.parse(ad.last_seen_at) : asOf;
  const end = ad.delivery_stop ? Date.parse(ad.delivery_stop) : lastSeen > asOf - ACTIVE_WINDOW_MS ? asOf : lastSeen;
  return {
    longevity_days: Math.max(0, Math.round((end - start) / DAY_MS)),
    is_active: !ad.delivery_stop && lastSeen > asOf - ACTIVE_WINDOW_MS,
  };
}

/**
 * The brand's tracked Meta pages (its own and the competitors') and their labelled ads,
 * with longevity pinned to `asOf` (default: the last scrape, the latest last_seen_at).
 */
export async function loadAds(
  db: SupabaseClient,
  brandProfileId: string,
  opts: { asOf?: string } = {},
): Promise<{ pages: Page[]; ads: LabelledAd[]; asOf: string }> {
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
  const lastScrape = ads.map((ad) => ad.last_seen_at ?? '').filter(Boolean).sort().at(-1);
  const asOf = opts.asOf ?? lastScrape ?? new Date().toISOString();
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) throw new Error(`--as-of "${asOf}" is not a date`);
  return { pages, ads: ads.map((ad) => ({ ...ad, ...pinLongevity(ad, asOfMs) })), asOf };
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
const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A link title that says nothing in a feed: the page's own name, a domain, or an unfilled template. */
function emptyTitle(title: string, pageName: string): boolean {
  const name = letters(pageName);
  const plain = letters(title);
  return (
    plain === name ||
    plain === `${name}cereal` ||
    title.includes('{{') ||
    /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(title.trim())
  );
}

/**
 * The labeller's staging notes as an image line. They are written as direction
 * ("Frame a person walking outdoors…"), so the leading verb goes and the first clause
 * stays: "A person walking outdoors in a coordinated outfit."
 */
const STAGING_VERB = /^(frame|center|centre|arrange|place|show|use|shoot|stage|position|capture|feature|set|keep|open on|photograph|film|depict|present|display|pair|layer|fill)\s+/i;
function imageLine(ad: LabelledAd): string {
  const notes = typeof ad.fingerprint?.execution_notes === 'string' ? flat(ad.fingerprint.execution_notes) : '';
  if (!notes) return '';
  const line = feedImage(notes.replace(STAGING_VERB, ''));
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : '';
}

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
    // The copy key keeps the raw first title, so a rerun with the feed cuts below keeps the same rows.
    const rawHeadline = firstRealBody(ad.creative_link_titles) || ad.hook_text?.trim() || firstSentence(body);
    const copyKey = `${page.brandId}\n${normalize(rawHeadline)}\n${normalize(body)}`;
    const copyOf = kept.get(copyKey);
    if (copyOf) {
      creativeIdForAd.set(ad.id, copyOf);
      continue;
    }
    const creativeId = `cr_live_${slugify(page.name)}_${slugify(ad.external_ad_id)}`;
    const title = (ad.creative_link_titles ?? []).map((text) => text?.trim() ?? '').find((text) => text && !emptyTitle(text, page.name));
    const headline = feedHeadline(title || ad.hook_text?.trim() || firstSentence(body));
    const image = ad.media_urls?.[0] ?? '';
    rows.push({
      creative_id: creativeId,
      arm_id: page.isSelf ? CONTROL_ARM_ID : '',
      brand_id: page.brandId,
      origin: page.isSelf ? 'brand_live' : 'competitor_live',
      headline,
      // What the feed shows before "… more"; the labeller's summary ("why it might work") is
      // analysis, not something a shopper sees, so it never reaches the sim.
      primary_text: feedPrimary(body),
      cta: DEFAULT_CTA,
      visual_description: imageLine(ad),
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

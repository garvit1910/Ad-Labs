import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { serviceSupabase } from '@/lib/adlab/supabase';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import { trustpilotUrlFromDomain } from '@/lib/brand-presence/trustpilot';
import type { SourceMeta } from '@/lib/brand-presence/types';
import { buildAdLibraryPageUrl } from '@/services/ad-library/apify-url';
import { createApifyClient, getApifyMaxAds } from '@/services/ad-library/apify-config';
import { normalizeApifyAd, type ApifyAdItem } from '@/services/ad-library/apify-normalizer';
import type { NormalizedAd } from '@/services/ad-library/types';
import { normalizeInstagramUsername } from '@/services/brand-presence/instagram-actor-input';
import { buildCommentsInput, buildProfileProbeInput, normalizeTikTokUsername } from '@/services/brand-presence/tiktok-actor-input';
import { TikTokApifyProvider, type TikTokRunHandle } from '@/services/brand-presence/tiktok-apify-provider';
import {
  extractVideoFromItem,
  normalizeTikTokCommentItem,
  type NormalizedTikTokVideo,
} from '@/services/brand-presence/tiktok-normalizer';
import { normalizeTrustpilotReviewItem, type NormalizedTrustpilotReview } from '@/services/brand-presence/trustpilot-normalizer';
import { normalizeXHandle } from '@/services/brand-presence/x-actor-input';
import { enqueueAdlibSyncJob, enqueueEnrichmentCatchUp } from '@/services/job-processor/ad-library/queue';
import { upsertAds } from '@/services/job-processor/ad-library/sync/persistence';
import {
  ADLIB_EMBED_BATCH_JOB_TYPE,
  ADLIB_LABEL_BATCH_JOB_TYPE,
  ADLIB_MEDIA_REHOST_JOB_TYPE,
  ADLIB_SYNC_COMPETITOR_JOB_TYPE,
} from '@/services/job-processor/ad-library/types';
import {
  confirmGoogleMapsSource,
  confirmInstagramSource,
  confirmTikTokSource,
  confirmTrustpilotSource,
} from '@/services/job-processor/brand-presence/confirm-source';
import {
  enqueueBrandPresenceDiscover,
  enqueueBrandPresenceScrape,
  enqueueBrandPresenceSubreddits,
  enqueueExtractOrDrainCluster,
  enqueueGooglePlaceResolve,
  enqueueInstagramProfileResolve,
  enqueueTikTokProfileResolve,
  enqueueTrustpilotResolve,
  enqueueXScrape,
} from '@/services/job-processor/brand-presence/queue';
import { awaitRunCompletion } from '@/services/job-processor/brand-presence/run-lifecycle';
import { BRAND_PRESENCE_DISCOVER_JOB_TYPE, BRAND_PRESENCE_JOB_TYPES } from '@/services/job-processor/brand-presence/types';
import { isApifyCapacityError, resetStaleJobs, runWorker } from '@/worker/loop';

/*
 * Ad Lab A2: ingest Magic Spoon and its seven competitors through the copied
 * job types and the job_queue worker (run in-process here, worker/loop.ts).
 *
 *   npm run a2:ingest -- <step> [--flags]
 *
 *   smoke      normalizeApifyAd over Adcero's apify-sample.json (no DB, no network)
 *   discover   brand_presence_discover on magicspoon.com, then print the draft profile
 *   sources    confirm the profile (Reddit starts), set up X, Trustpilot, Google Maps,
 *              TikTok and Instagram, pin TikTok's comment fields, confirm the resolved
 *              cards, drain the whole listening pipeline. Flags: --variants=a,b
 *              --x= --instagram= --tiktok= --trustpilot=<domain> --maps=<url> --maps-ok
 *   pages      upsert the 8 Meta-only tracked_competitors rows and print them (no scrape)
 *   ads --ok   sync -> label -> embed all 8 pages (after Person A OKs the pages table)
 *   prove      Magic Spoon's own ads never reach the market step's ad pool
 *   report     counts per source and per page; exits 1 unless A2's done-when holds
 *
 * Every step is idempotent. The Adcero setup/confirm routes were not copied, so
 * `sources` repeats their few DB writes and then calls the copied enqueue and
 * confirm-source functions.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WEBSITE_URL = new URL('https://magicspoon.com').toString();
const BRAND_DOMAIN = 'magicspoon.com';
const GOOGLE_MAPS_SEARCH_URL = 'https://www.google.com/maps/search/Magic+Spoon+Cereal/';

// docs/PLAN.md "A2": the locked competitor set (Oct 24) plus Magic Spoon's own page.
const COMPETITOR_PAGES = [
  { name: 'Catalina Crunch', pageId: '140848183352200' },
  { name: 'Seven Sundays', pageId: '215741341794742' },
  { name: 'Surreal', pageId: '103157908647433' },
  { name: 'GHOST', pageId: '1453082168348885' },
  { name: 'Premier Protein', pageId: '78022578902' },
  { name: 'Legendary Foods', pageId: '435452713326784' },
  { name: 'Quest Nutrition', pageId: '109793645727352' },
];
const SELF_PAGE = { name: 'Magic Spoon', pageId: '1978160732305312' };
const PAGES = [{ ...SELF_PAGE, self: true }, ...COMPETITOR_PAGES.map((page) => ({ ...page, self: false }))];
// Every page is labelled with the food vocabulary the contract's angle tokens come from.
const PAGE_INDUSTRY = 'food';

// A0 insurance datasets (docs/PLAN.md "A2"), imported only when a live scrape fails or is empty.
const INSURANCE_ADS: Record<string, string> = {
  [SELF_PAGE.pageId]: '3gFmofqMK6sEyeHto',
  '140848183352200': '1IPZWLnFfFMWN01fa',
};
const INSURANCE_TRUSTPILOT = '8XhvrGA89aht0K74A';

// Syncs wait out Apify's 5-run limit in the worker. Label batches get their own lanes:
// each fans out one gpt-6-luna vision call per ad (~40k tokens per batch), and the
// worker pauses the type for a minute if OpenAI's per-minute limit trips anyway.
const ADLIB_POOLS = [
  { types: [ADLIB_SYNC_COMPETITOR_JOB_TYPE, ADLIB_EMBED_BATCH_JOB_TYPE, ADLIB_MEDIA_REHOST_JOB_TYPE], concurrency: 8 },
  { types: [ADLIB_LABEL_BATCH_JOB_TYPE], concurrency: 4 },
];
const LISTENING_POOLS = [{ types: BRAND_PRESENCE_JOB_TYPES, concurrency: 8 }];
const MENTION_PLATFORMS = ['reddit', 'x', 'trustpilot', 'google_maps', 'tiktok', 'instagram'];
const RELEVANCE_VALUES = ['pending', 'relevant', 'irrelevant', 'not_required'];
const UPSERT_CHUNK_SIZE = 100;
const IDLE_POLL_MS = 10_000;
const PROGRESS_EVERY_MS = 30_000;

const [step, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
for (const arg of rest) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (match) flags.set(match[1], match[2] ?? 'true');
}

const db = serviceSupabase();
const shutdown = new AbortController();
process.once('SIGINT', () => {
  console.log('[a2] stopping: in-flight jobs go back to pending (Ctrl-C again to force)');
  shutdown.abort();
  process.once('SIGINT', () => process.exit(130));
});

const nowIso = () => new Date().toISOString();
const log = (message: string) => console.log(`[a2] ${message}`);
// PostgREST errors are plain objects ({ message, code, details }), not Error instances.
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? JSON.stringify(error)
      : String(error);

function table(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown) => (value === null || value === undefined ? '' : String(value));
  const widths = keys.map((key) => Math.max(key.length, ...rows.map((row) => cell(row[key]).length)));
  const line = (values: string[]) => values.map((value, i) => value.padEnd(widths[i])).join('  ');
  console.log(line(keys));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(keys.map((key) => cell(row[key]))));
}

// ---------------------------------------------------------------- queue

interface JobRow {
  id: string;
  type: string;
  status: string;
  error_message: string | null;
}

/** A read-only query, retried through Supabase network blips (about a minute) before giving up. */
async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 12 || shutdown.signal.aborted) throw error;
      log(`read failed (${attempt}/12), retrying: ${errorMessage(error)}`);
      await sleep(5_000, undefined, { signal: shutdown.signal });
    }
  }
}

async function getJob(jobId: string): Promise<JobRow> {
  const { data, error } = await db.from('job_queue').select('id, type, status, error_message').eq('id', jobId).single();
  if (error) throw error;
  return data as JobRow;
}

/** Polls one job until it leaves pending/processing (the in-process lanes run it). */
async function waitForJob(jobId: string): Promise<JobRow> {
  for (;;) {
    const job = await retryRead(() => getJob(jobId));
    if (job.status !== 'pending' && job.status !== 'processing') return job;
    await sleep(IDLE_POLL_MS, undefined, { signal: shutdown.signal });
  }
}

/** One in-process worker: the job types it claims and how many it runs at a time. */
interface Pool {
  types: readonly string[];
  concurrency: number;
}

/**
 * Runs the worker pools in-process while `during` does the step's own work, then
 * until no job of their types is pending or processing. One query reads both
 * statuses, so a parent finishing after it enqueued children never reads as idle.
 */
async function drainUntilIdle(label: string, pools: Pool[], during?: () => Promise<void>): Promise<JobRow[]> {
  const startedAt = nowIso();
  const types = pools.flatMap((pool) => pool.types);
  const stale = await resetStaleJobs(db);
  if (stale > 0) log(`reset ${stale} stale processing job(s) to pending`);
  log(`${label}: draining ${pools.map((pool) => `${pool.types.length} job type(s) on ${pool.concurrency} lane(s)`).join(' + ')}`);

  const stop = new AbortController();
  let workerError: unknown = null;
  const workers = Promise.all(
    pools.map((pool) =>
      runWorker(db, { concurrency: pool.concurrency, watch: true, types: pool.types, signal: shutdown.signal, stop: stop.signal }),
    ),
  ).catch((error: unknown) => {
    workerError = error;
    return null;
  });
  try {
    if (during) await during();
    let lastProgress = 0;
    for (;;) {
      if (workerError) throw workerError;
      if (shutdown.signal.aborted) throw new Error('stopped');
      const data = await retryRead(async () => {
        const { data: rows, error } = await db
          .from('job_queue')
          .select('type, status')
          .in('type', types)
          .in('status', ['pending', 'processing']);
        if (error) throw error;
        return rows ?? [];
      });
      if (data.length === 0) break;
      if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
        const byType = new Map<string, string>();
        for (const row of data) {
          const key = String(row.type);
          byType.set(key, `${byType.get(key) ?? ''}${row.status === 'processing' ? 'P' : '.'}`);
        }
        log(`${label}: waiting on ${[...byType].map(([type, marks]) => `${type} [${marks}]`).join(', ')}`);
        lastProgress = Date.now();
      }
      await sleep(IDLE_POLL_MS, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  } finally {
    stop.abort();
  }
  const counts = await workers;
  if (workerError) throw workerError;
  if (counts) {
    const sum = (key: keyof (typeof counts)[number]) => counts.reduce((n, c) => n + c[key], 0);
    log(`${label}: idle (${sum('completed')} completed, ${sum('failed')} failed, ${sum('requeued')} requeued, ${sum('skipped')} skipped here)`);
  }

  const { data: failed, error } = await db
    .from('job_queue')
    .select('id, type, status, error_message')
    .in('type', types)
    .eq('status', 'failed')
    .gte('completed_at', startedAt);
  if (error) throw error;
  for (const job of (failed ?? []) as JobRow[]) {
    console.warn(`[a2] ${label}: FAILED ${job.type} ${job.id.slice(0, 8)}: ${job.error_message?.slice(0, 300)}`);
  }
  return (failed ?? []) as JobRow[];
}

// ---------------------------------------------------------------- rows

interface ProfileRow {
  id: string;
  status: string;
  brand_name: string;
  name_variants: string[];
  category: string | null;
  competitors: string[];
  product_description: string | null;
  meta: Record<string, unknown> | null;
}

async function loadProfile(): Promise<ProfileRow> {
  const { data, error } = await db
    .from('brand_presence_profiles')
    .select('id, status, brand_name, name_variants, category, competitors, product_description, meta')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('website_url', WEBSITE_URL)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No brand_presence_profiles row for ${WEBSITE_URL}: run the discover step first`);
  return data as ProfileRow;
}

interface SourceRow {
  id: string;
  source_type: string;
  status: string;
  label: string | null;
  meta: SourceMeta | null;
  last_synced_at: string | null;
}

/** Never synced, or --resync: the step may (re)queue this source's billable scrape. */
const fresh = (row: { last_synced_at: string | null }) => !row.last_synced_at || flags.has('resync');

async function loadSource(brandProfileId: string, sourceType: string): Promise<SourceRow> {
  const { data, error } = await db
    .from('brand_presence_sources')
    .select('id, source_type, status, label, meta, last_synced_at')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('brand_profile_id', brandProfileId)
    .eq('source_type', sourceType)
    .eq('uri', '')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No seeded ${sourceType} source for profile ${brandProfileId}: rerun discover`);
  return data as SourceRow;
}

async function updateSource(sourceId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from('brand_presence_sources')
    .update({ ...patch, updated_at: nowIso() })
    .eq('id', sourceId)
    .eq('organization_id', ADLAB_ORG_ID);
  if (error) throw error;
}

interface PageRow {
  id: string;
  name: string;
  meta_page_id: string;
  meta_page_name: string | null;
  country: string;
  industry: string | null;
  is_brand_self: boolean;
  status: string;
  last_synced_at: string | null;
  scores: Record<string, unknown> | null;
  tags: Record<string, unknown> | null;
}

async function loadPages(brandProfileId: string): Promise<PageRow[]> {
  const { data, error } = await db
    .from('tracked_competitors')
    .select('id, name, meta_page_id, meta_page_name, country, industry, is_brand_self, status, last_synced_at, scores, tags')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('brand_profile_id', brandProfileId)
    .eq('platform', 'meta')
    .in('meta_page_id', PAGES.map((page) => page.pageId));
  if (error) throw error;
  const rows = (data ?? []) as PageRow[];
  // Locked order: Magic Spoon first, then the seven competitors.
  return PAGES.flatMap((page) => rows.filter((row) => row.meta_page_id === page.pageId));
}

async function countRows(tableName: string, filter: (query: any) => any): Promise<number> {
  const { count, error } = await filter(db.from(tableName).select('*', { count: 'exact', head: true }));
  if (error) throw error;
  return count ?? 0;
}

async function adCount(competitorId: string): Promise<number> {
  return countRows('library_ads', (q) => q.eq('organization_id', ADLAB_ORG_ID).eq('competitor_id', competitorId));
}

interface PageStats {
  ads: number;
  labelled: number;
  embedded: number;
  active: number;
  angles: string;
}

async function pageStats(competitorId: string): Promise<PageStats> {
  const { data: ads, error } = await db
    .from('library_ads_enriched')
    .select('id, hook_archetype, angle, is_active')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('competitor_id', competitorId);
  if (error) throw error;
  const rows = ads ?? [];
  const ids = rows.map((row) => String(row.id));
  let embedded = 0;
  for (let i = 0; i < ids.length; i += UPSERT_CHUNK_SIZE) {
    embedded += await countRows('ad_embeddings', (q) =>
      q.eq('organization_id', ADLAB_ORG_ID).in('library_ad_id', ids.slice(i, i + UPSERT_CHUNK_SIZE)),
    );
  }
  const angles = new Map<string, number>();
  for (const row of rows) {
    if (row.angle) angles.set(String(row.angle), (angles.get(String(row.angle)) ?? 0) + 1);
  }
  return {
    ads: rows.length,
    labelled: rows.filter((row) => row.hook_archetype).length,
    embedded,
    active: rows.filter((row) => row.is_active).length,
    angles: [...angles].sort((a, b) => b[1] - a[1]).map(([angle, n]) => `${angle} ${n}`).join(', '),
  };
}

// ---------------------------------------------------------------- smoke

async function smoke(): Promise<void> {
  const fixture = resolve(flags.get('fixture') ?? join(REPO_ROOT, '../adcero/tests/fixtures/ad-library/apify-sample.json'));
  const items = JSON.parse(readFileSync(fixture, 'utf8')) as ApifyAdItem[];
  const ads = items.map(normalizeApifyAd);
  const first = ads[0];
  // The same anchors as Adcero's tests/unit/ad-library/apify-normalizer.test.ts.
  const checks: Array<[string, boolean]> = [
    [`${items.length} items, all normalize`, items.length === 11 && ads.every((ad) => ad !== null)],
    ['first ad id 674488985724894', first?.externalAdId === '674488985724894'],
    ['first page "Sungboon Editor US"', first?.pageName === 'Sungboon Editor US'],
    ['first media type video', first?.mediaType === 'video'],
    ['first ad has body copy', (first?.creativeBodies.length ?? 0) > 0],
  ];
  table(
    ads.filter((ad): ad is NormalizedAd => ad !== null).map((ad) => ({
      ad: ad.externalAdId,
      page: ad.pageName,
      media: ad.mediaType,
      bodies: ad.creativeBodies.length,
      start: ad.deliveryStart.slice(0, 10),
      active: ad.deliveryStop === null,
      landing: ad.landingDomain ?? '',
    })),
  );
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

// ---------------------------------------------------------------- discover

async function discover(): Promise<void> {
  const { jobId, deduped } = await enqueueBrandPresenceDiscover(db, {
    organizationId: ADLAB_ORG_ID,
    websiteUrl: WEBSITE_URL,
    presenceRole: 'self',
  });
  log(`brand_presence_discover ${deduped ? 'already queued' : 'queued'} (${jobId}) for ${WEBSITE_URL}`);
  await drainUntilIdle('discover', [{ types: [BRAND_PRESENCE_DISCOVER_JOB_TYPE], concurrency: 1 }]);
  const job = await getJob(jobId);
  if (job.status !== 'completed') throw new Error(`discover ${job.status}: ${job.error_message}`);
  printProfile(await loadProfile());
}

function printProfile(profile: ProfileRow): void {
  const discovery = (profile.meta?.discovery ?? {}) as { homepageBlocked?: boolean };
  console.log(`profile ${profile.id} (${profile.status})`);
  console.log(`  brand_name:      ${profile.brand_name}`);
  console.log(`  name_variants:   ${profile.name_variants.join(' | ')}`);
  console.log(`  category:        ${profile.category}`);
  console.log(`  competitors:     ${profile.competitors.join(' | ')}`);
  console.log(`  description:     ${profile.product_description}`);
  console.log(`  homepageBlocked: ${discovery.homepageBlocked ?? false}`);
}

// ---------------------------------------------------------------- sources

/** Social handles linked from the brand's homepage. A plain fetch: the copied
 * fetcher caps pages at 500 KB, and the links sit in the footer. */
async function homepageHandles(): Promise<{ x?: string; instagram?: string; tiktok?: string }> {
  let html = '';
  try {
    const response = await fetch(WEBSITE_URL, { headers: { 'user-agent': 'Mozilla/5.0 (Ad Lab A2)' } });
    html = await response.text();
  } catch (error) {
    log(`homepage fetch failed, handles need flags: ${errorMessage(error)}`);
  }
  const links = [...html.matchAll(/https?:\/\/(?:www\.)?(?:instagram|tiktok|twitter|x)\.com\/[^"'\s<>]+/gi)].map((m) => m[0]);
  const first = (host: RegExp, normalize: (raw: string) => string | null) => {
    for (const link of links) {
      if (!host.test(link)) continue;
      const handle = normalize(link);
      if (handle) return handle;
    }
    return undefined;
  };
  return {
    x: first(/\/\/(?:www\.)?(?:twitter|x)\.com\//i, normalizeXHandle),
    instagram: first(/instagram\.com\//i, normalizeInstagramUsername),
    tiktok: first(/tiktok\.com\//i, normalizeTikTokUsername),
  };
}

/** Starts an Apify run, waiting out the account's concurrent-run limit like the worker does. */
async function withApifySlot<T>(start: () => Promise<T>, label: string): Promise<T> {
  for (;;) {
    try {
      return await start();
    } catch (error) {
      if (!isApifyCapacityError(error)) throw error;
      log(`${label}: waiting for an Apify run slot`);
      await sleep(30_000, undefined, { signal: shutdown.signal });
    }
  }
}

interface PinResult {
  ok: boolean;
  fields: string[];
}

/**
 * docs/PLAN.md gotcha: TikTok's Hop-2 field names were never pinned. One small
 * live run (a 5-video Hop-1 probe, then ~20 comments from its most-commented
 * video) checks every candidate key tiktok-normalizer.ts probes, before any
 * harvest is confirmed.
 */
async function pinTikTokFields(username: string): Promise<PinResult> {
  const dumpPath = join(REPO_ROOT, 'data/a2/tiktok-comments-pin.json');
  let dump: { username: string; videos: NormalizedTikTokVideo[]; items: unknown[] } | null = null;
  try {
    dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  } catch {
    dump = null;
  }
  if (!dump || dump.username !== username || flags.has('repin')) {
    const provider = new TikTokApifyProvider();
    const runToEnd = async (start: () => Promise<TikTokRunHandle>, label: string): Promise<unknown[]> => {
      const handle = await withApifySlot(start, label);
      const outcome = await awaitRunCompletion({ provider, runId: handle.runId, runStartedAt: nowIso(), signal: shutdown.signal, label });
      if (outcome.outcome === 'failed') throw new Error(`${label}: run ${handle.runId} failed`);
      return provider.listDatasetItems(handle.datasetId, 0, 100);
    };
    const videoItems = await runToEnd(() => provider.startProfileRun(buildProfileProbeInput(username)), '[a2] tiktok pin, videos');
    const videos = videoItems.flatMap((raw) => {
      const result = extractVideoFromItem(raw);
      return result.kind === 'video' ? [result.video] : [];
    });
    if (videos.length === 0) {
      log(`tiktok pin: no videos on @${username}`);
      return { ok: false, fields: [] };
    }
    const target = [...videos].sort((a, b) => b.comment_count - a.comment_count)[0];
    log(`tiktok pin: ~20 comments from ${target.url} (${target.comment_count} comments)`);
    const items = await runToEnd(
      () => provider.startCommentsRun(buildCommentsInput({ urls: [target.url], commentsPerPost: 20 })),
      '[a2] tiktok pin, comments',
    );
    dump = { username, videos, items };
    mkdirSync(dirname(dumpPath), { recursive: true });
    writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  } else {
    log(`tiktok pin: re-checking the saved run in ${dumpPath} (--repin to scrape again)`);
  }
  const { videos, items } = dump;

  const records = items.filter((raw): raw is Record<string, unknown> => raw !== null && typeof raw === 'object');
  const markers = records.filter((item) => typeof item.error === 'string');
  const real = records.filter((item) => typeof item.error !== 'string');
  const read = (item: Record<string, unknown>, path: string) =>
    path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), item);
  // The candidate keys tiktok-normalizer.ts reads, per field.
  const candidates: Record<string, string[]> = {
    id: ['cid', 'id', 'commentId'],
    body: ['text', 'comment'],
    author: ['uniqueId', 'user.uniqueId', 'user.unique_id'],
    video: ['videoWebUrl', 'postUrl', 'videoId', 'awemeId', 'postId'],
    postedAt: ['createTimeISO', 'createTime'],
    likes: ['diggCount', 'likesCount'],
    replies: ['replyCommentTotal', 'replyCommentCount', 'repliesCount'],
    parent: ['repliesToId', 'parentCommentId'],
  };
  const fields: string[] = [];
  for (const [field, keys] of Object.entries(candidates)) {
    const hits = keys
      .map((key) => [key, real.filter((item) => read(item, key) !== undefined && read(item, key) !== null && read(item, key) !== '').length] as const)
      .filter(([, n]) => n > 0);
    const summary = hits.length ? hits.map(([key, n]) => `${key} ${n}/${real.length}`).join(', ') : 'none';
    fields.push(`${field} <- ${summary}`);
  }
  const allKeys = [...new Set(real.flatMap((item) => Object.keys(item)))].sort();

  const lookup = new Map(videos.map((video) => [video.video_id, { url: video.url, caption: video.caption }]));
  const results = real.map((raw) => normalizeTikTokCommentItem(raw, { ownerUsername: username, videoLookup: (id) => lookup.get(id) }));
  const kept = results.filter((result) => result.kind === 'mention');
  const reasons = new Map<string, number>();
  for (const result of results) {
    if (result.kind === 'skipped') reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
  }
  const hardSkips = ['missing comment id', 'empty body', 'unresolvable parent video'].reduce((n, reason) => n + (reasons.get(reason) ?? 0), 0);
  const ok = kept.length > 0 && hardSkips === 0;

  console.log(`tiktok pin: ${records.length} items (${markers.length} actor markers), raw dump ${dumpPath}`);
  for (const line of fields) console.log(`  ${line}`);
  console.log(`  item keys: ${allKeys.join(', ')}`);
  console.log(
    `  normalizer: ${kept.length} kept (${kept.filter((r) => r.kind === 'mention' && r.mention.short_text).length} short), ` +
      `${[...reasons].map(([reason, n]) => `${reason} ${n}`).join(', ') || 'none skipped'}`,
  );
  console.log(
    ok
      ? '  PINNED: the normalizer reads this actor build; TikTok harvest may run'
      : '  NOT PINNED: tiktok-normalizer.ts (a copied file) needs a change; TikTok stays unconfirmed. Ask Person A.',
  );
  return { ok, fields };
}

async function sources(): Promise<void> {
  const profile = await loadProfile();
  const brandProfileId = profile.id;
  const scope = { organizationId: ADLAB_ORG_ID, brandProfileId };
  const outcomes: Array<{ source: string; outcome: string }> = [];
  const note = (source: string, outcome: string) => {
    outcomes.push({ source, outcome });
    log(`${source}: ${outcome}`);
  };

  const caps = BRAND_PRESENCE_CONFIG;
  log(
    `caps (Adcero defaults, lib/brand-presence/config.ts): reddit brand ${caps.brandSearch.maxItems} + threads ${caps.brandThreads.maxItems}` +
      ` + ${caps.subredditSearch.maxItems}/subreddit + category ${caps.categorySearch.maxItems};` +
      ` x handle ${caps.x.handleSearch.maxItems} + variants ${caps.x.variantSearch.maxItems};` +
      ` trustpilot ${caps.trustpilot.negativeBackfillMaxItems} 1-2★ + ${caps.trustpilot.backfillMaxItems};` +
      ` maps ${caps.google.backfillMaxReviews};` +
      ` tiktok ${caps.tiktok.selection.topByComments}+${caps.tiktok.selection.recentCount} videos x ${caps.tiktok.backfill.commentsPerVideo};` +
      ` instagram ${caps.instagram.selection.topByComments}+${caps.instagram.selection.recentCount} posts x ${caps.instagram.perPostCommentCap}`,
  );

  // 1. Profile: Person A's checks, then Adcero's profile/confirm route (status + Reddit).
  const variants = flags.get('variants')?.split(',').map((v) => v.trim()).filter(Boolean);
  const { error: profileError } = await db
    .from('brand_presence_profiles')
    .update({
      ...(variants?.length ? { name_variants: variants } : {}),
      competitors: COMPETITOR_PAGES.map((page) => page.name),
      status: 'confirmed',
      updated_at: nowIso(),
    })
    .eq('id', brandProfileId)
    .eq('organization_id', ADLAB_ORG_ID);
  if (profileError) throw profileError;
  printProfile(await loadProfile());

  // 2. Handles: homepage links, overridden by flags.
  const found = await homepageHandles();
  const handles = {
    x: flags.has('x') ? normalizeXHandle(flags.get('x')!) : (found.x ?? null),
    instagram: flags.has('instagram') ? normalizeInstagramUsername(flags.get('instagram')!) : (found.instagram ?? null),
    tiktok: flags.has('tiktok') ? normalizeTikTokUsername(flags.get('tiktok')!) : (found.tiktok ?? null),
  };
  log(`handles: x @${handles.x ?? '?'}, instagram @${handles.instagram ?? '?'}, tiktok @${handles.tiktok ?? '?'}`);
  const trustpilotDomain = flags.get('trustpilot') ?? BRAND_DOMAIN;
  const mapsUrl = flags.get('maps') ?? GOOGLE_MAPS_SEARCH_URL;

  const drainFailures = await drainUntilIdle('sources', LISTENING_POOLS, async () => {
    // Reddit: subreddit discovery plus the two seeded search sources (profile/confirm).
    // A source that already synced is left alone unless --resync, so reruns never re-bill.
    const redditSearch = await loadSource(brandProfileId, 'reddit_search');
    if (fresh(redditSearch)) {
      const subreddits = await enqueueBrandPresenceSubreddits(db, scope);
      log(`reddit: subreddit discovery queued (${subreddits.jobId})`);
    }
    for (const source of [redditSearch, await loadSource(brandProfileId, 'reddit_category')]) {
      if (!fresh(source)) {
        note(source.source_type, 'already synced');
        continue;
      }
      const { jobId } = await enqueueBrandPresenceScrape(db, { ...scope, sourceId: source.id });
      note(source.source_type, `scrape queued (${jobId})`);
    }

    // X: Adcero's x/setup route confirms the handle and queues the scrape in one step.
    const x = await loadSource(brandProfileId, 'x');
    if (!handles.x) {
      note('x', 'needs a handle (--x=)');
    } else if (!fresh(x)) {
      note('x', 'already synced');
    } else {
      const meta: SourceMeta = { ...(x.meta ?? {}) };
      const configChanged = meta.x?.handle !== handles.x || meta.x?.nameSearchOnly !== false;
      if (configChanged) {
        delete meta.cursor;
        delete meta.sync;
      }
      delete meta.lastError;
      meta.x = {
        handle: handles.x,
        nameSearchOnly: false,
        confirmedAt: nowIso(),
        ...(configChanged ? {} : { queryStats: meta.x?.queryStats, lastRun: meta.x?.lastRun }),
      };
      await updateSource(x.id, { meta, label: 'X (Twitter)', status: 'pending' });
      const { jobId } = await enqueueXScrape(db, { ...scope, sourceId: x.id });
      note('x', `@${handles.x} confirmed, scrape queued (${jobId})`);
    }

    // The resolve probes, as the setup routes queue them, but never auto-confirmed:
    // each card is checked below and confirmed through confirm-source.ts.
    const trustpilot = await loadSource(brandProfileId, 'trustpilot');
    if (trustpilot.meta?.trustpilot?.page?.domain !== trustpilotDomain) {
      const meta: SourceMeta = { ...(trustpilot.meta ?? {}) };
      delete meta.cursor;
      delete meta.sync;
      delete meta.lastError;
      meta.trustpilot = {
        page: {
          url: trustpilotUrlFromDomain(trustpilotDomain),
          domain: trustpilotDomain,
          title: null,
          trustScore: null,
          reviewsCount: null,
          resolvedAt: '',
          degraded: false,
        },
      };
      await updateSource(trustpilot.id, { meta, label: 'Trustpilot', status: 'pending' });
    }

    const maps = await loadSource(brandProfileId, 'google_maps_reviews');
    if (maps.meta?.place?.url !== mapsUrl) {
      const meta: SourceMeta = { ...(maps.meta ?? {}) };
      delete meta.cursor;
      delete meta.sync;
      delete meta.resolve;
      delete meta.lastError;
      meta.place = { url: mapsUrl, placeId: null, title: null, address: null, totalScore: null, reviewsCount: null, resolvedAt: '', degraded: false };
      await updateSource(maps.id, { meta, label: 'Google Maps reviews', status: 'pending' });
    }

    const tiktok = await loadSource(brandProfileId, 'tiktok_comments');
    if (handles.tiktok && !tiktok.meta?.tiktok?.profile?.confirmedAt) {
      const meta: SourceMeta = { ...(tiktok.meta ?? {}) };
      if (meta.tiktok?.username !== handles.tiktok) {
        delete meta.cursor;
        delete meta.sync;
        meta.tiktok = { username: handles.tiktok };
      }
      delete meta.lastError;
      await updateSource(tiktok.id, { meta, label: `TikTok — @${handles.tiktok}`, status: 'pending' });
    }

    const instagram = await loadSource(brandProfileId, 'instagram_comments');
    if (handles.instagram && !instagram.meta?.instagram?.profile?.confirmedAt) {
      const meta: SourceMeta = { ...(instagram.meta ?? {}) };
      if (meta.instagram?.username !== handles.instagram) {
        delete meta.cursor;
        delete meta.sync;
        meta.instagram = { username: handles.instagram };
      }
      delete meta.lastError;
      await updateSource(instagram.id, { meta, label: `Instagram — @${handles.instagram}`, status: 'pending' });
    }

    await Promise.all([
      confirmTrustpilot(scope, trustpilot.id, note),
      confirmMaps(scope, maps.id, note),
      handles.tiktok ? confirmTikTok(scope, tiktok.id, handles.tiktok, note) : note('tiktok', 'needs a handle (--tiktok=)'),
      handles.instagram ? confirmInstagram(scope, instagram.id, note) : note('instagram', 'needs a handle (--instagram=)'),
    ]);
  });

  // 3. Insurance: Trustpilot is the one listening source with an A0 dataset.
  const trustpilotRows = await countRows('brand_mentions', (q) => q.eq('brand_profile_id', brandProfileId).eq('platform', 'trustpilot'));
  if (trustpilotRows === 0) {
    const imported = await importTrustpilotInsurance(brandProfileId);
    note('trustpilot', `INSURANCE: live scrape gave 0 reviews; imported ${imported} from A0 dataset ${INSURANCE_TRUSTPILOT}`);
    const { extractIds } = await enqueueExtractOrDrainCluster(db, { ...scope, excludeJobId: randomUUID() });
    log(`trustpilot insurance: ${extractIds.length} reviews queued for extraction`);
    drainFailures.push(...(await drainUntilIdle('sources: insurance extract', LISTENING_POOLS)));
  }

  console.log('\nsources');
  table(outcomes);
  await printSources(brandProfileId);
  await printMentionCounts(brandProfileId);
  if (drainFailures.length) log(`${drainFailures.length} listening job(s) failed; see the FAILED lines above`);
}

type Note = (source: string, outcome: string) => void;
type Scope = { organizationId: string; brandProfileId: string };

/**
 * A source's resolve card: the stored one when an earlier probe already resolved
 * it cleanly, else a fresh probe run by the in-process lanes.
 */
async function resolveCard<T extends { resolvedAt: string; degraded: boolean }>(
  brandProfileId: string,
  sourceType: string,
  read: (meta: SourceMeta) => T | undefined,
  probe: () => Promise<{ jobId: string }>,
): Promise<{ card: T | undefined; resolve: string }> {
  const stored = read((await loadSource(brandProfileId, sourceType)).meta ?? {});
  if (stored?.resolvedAt && !stored.degraded) return { card: stored, resolve: 'stored card' };
  const job = await waitForJob((await probe()).jobId);
  const card = read((await loadSource(brandProfileId, sourceType)).meta ?? {});
  return { card, resolve: `resolve ${job.status}${job.error_message ? `: ${job.error_message}` : ''}` };
}

async function confirmTrustpilot(scope: Scope, sourceId: string, note: Note): Promise<void> {
  try {
    const source = await loadSource(scope.brandProfileId, 'trustpilot');
    if (source.meta?.trustpilot?.page?.confirmedAt) return note('trustpilot', 'already confirmed');
    const { card: page, resolve } = await resolveCard(scope.brandProfileId, 'trustpilot', (meta) => meta.trustpilot?.page, () =>
      enqueueTrustpilotResolve(db, { ...scope, sourceId, allowSearchFallback: false, autoConfirm: false }),
    );
    log(
      `trustpilot card: ${page?.title ?? '?'} (${page?.domain}), ${page?.reviewsCount ?? '?'} reviews, score ${page?.trustScore ?? '?'}, ` +
        `verified domain ${page?.verifiedDomain ?? '?'}${page?.degraded ? ', DEGRADED' : ''} [${resolve}]`,
    );
    if (!page?.resolvedAt || page.degraded) {
      note('trustpilot', `not confirmed: the probe could not verify the page, ${resolve} (insurance after drain)`);
      return;
    }
    const result = await confirmTrustpilotSource(db, scope);
    note('trustpilot', `confirmed, reviews scrape ${result.deduped ? 'already queued' : 'queued'} (${result.jobId})`);
  } catch (error) {
    note('trustpilot', `not confirmed: ${errorMessage(error)} (insurance after drain)`);
  }
}

async function confirmMaps(scope: Scope, sourceId: string, note: Note): Promise<void> {
  try {
    const source = await loadSource(scope.brandProfileId, 'google_maps_reviews');
    if (source.meta?.place?.confirmedAt) return note('google_maps', 'already confirmed');
    const { card: place, resolve } = await resolveCard(scope.brandProfileId, 'google_maps_reviews', (meta) => meta.place, () =>
      enqueueGooglePlaceResolve(db, { ...scope, sourceId, autoConfirm: false }),
    );
    log(
      `google maps card: ${place?.title ?? 'no place'}${place?.address ? ` (${place.address})` : ''}, ${place?.reviewsCount ?? '?'} reviews` +
        `${place?.degraded ? ', DEGRADED' : ''}${place?.brandMismatch ? ', BRAND MISMATCH' : ''} [${resolve}]`,
    );
    const why = !place?.resolvedAt
      ? resolve
      : place.degraded || !place.reviewsCount
        ? 'no Google Maps place with reviews (Magic Spoon sells online)'
        : place.brandMismatch
          ? `found "${place.title}", which doesn't name the brand`
          : !flags.has('maps') && !flags.has('maps-ok')
            ? `found "${place.title}" by search; rerun with --maps-ok if it is Magic Spoon's own listing`
            : null;
    if (why) {
      await updateSource(sourceId, { status: 'available', label: 'Google Maps reviews (skipped)' });
      note('google_maps', `SKIPPED: ${why}`);
      return;
    }
    const result = await confirmGoogleMapsSource(db, scope);
    note('google_maps', `confirmed, review scrape ${result.deduped ? 'already queued' : 'queued'} (${result.jobId})`);
  } catch (error) {
    if (shutdown.signal.aborted) throw error;
    await updateSource(sourceId, { status: 'available', label: 'Google Maps reviews (skipped)' }).catch(() => {});
    note('google_maps', `SKIPPED: ${errorMessage(error)}`);
  }
}

async function confirmTikTok(scope: Scope, sourceId: string, username: string, note: Note): Promise<void> {
  try {
    const source = await loadSource(scope.brandProfileId, 'tiktok_comments');
    if (source.meta?.tiktok?.profile?.confirmedAt) return note('tiktok', 'already confirmed');
    const [pin, { card, resolve }] = await Promise.all([
      pinTikTokFields(username),
      resolveCard(scope.brandProfileId, 'tiktok_comments', (meta) => meta.tiktok?.profile, () =>
        enqueueTikTokProfileResolve(db, { ...scope, sourceId, autoConfirm: false }),
      ),
    ]);
    log(
      `tiktok card: @${card?.username ?? username} ${card?.displayName ?? ''}, ${card?.followers ?? '?'} followers, ` +
        `${card?.videoCount ?? '?'} videos${card?.degraded ? ', DEGRADED' : ''}${card?.unavailable ? `, ${card.unavailable}` : ''} [${resolve}]`,
    );
    if (!pin.ok) {
      note('tiktok', 'NOT CONFIRMED: comment fields did not pin (see the pin output)');
      return;
    }
    if (!card?.resolvedAt || card.degraded || card.unavailable) {
      note('tiktok', `not confirmed: ${card?.unavailableMessage ?? resolve}`);
      return;
    }
    const result = await confirmTikTokSource(db, scope);
    note('tiktok', `confirmed, comment harvest ${result.deduped ? 'already queued' : 'queued'} (${result.jobId})`);
  } catch (error) {
    note('tiktok', `not confirmed: ${errorMessage(error)}`);
  }
}

async function confirmInstagram(scope: Scope, sourceId: string, note: Note): Promise<void> {
  try {
    const source = await loadSource(scope.brandProfileId, 'instagram_comments');
    if (source.meta?.instagram?.profile?.confirmedAt) return note('instagram', 'already confirmed');
    const { card, resolve } = await resolveCard(scope.brandProfileId, 'instagram_comments', (meta) => meta.instagram?.profile, () =>
      enqueueInstagramProfileResolve(db, { ...scope, sourceId, autoConfirm: false }),
    );
    log(
      `instagram card: @${card?.username ?? '?'} ${card?.fullName ?? ''}, ${card?.followers ?? '?'} followers, ` +
        `${card?.postsCount ?? '?'} posts${card?.degraded ? ', DEGRADED' : ''}${card?.unavailable ? `, ${card.unavailable}` : ''} [${resolve}]`,
    );
    if (!card?.resolvedAt || card.degraded || card.unavailable) {
      note('instagram', `not confirmed: ${card?.unavailableMessage ?? resolve}`);
      return;
    }
    const result = await confirmInstagramSource(db, scope);
    note('instagram', `confirmed, comment harvest ${result.deduped ? 'already queued' : 'queued'} (${result.jobId})`);
  } catch (error) {
    note('instagram', `not confirmed: ${errorMessage(error)}`);
  }
}

/**
 * A0's Trustpilot dataset through the copied normalizer, into brand_mentions rows
 * shaped exactly like trustpilot-reviews-processor.ts buildRow (private there).
 */
async function importTrustpilotInsurance(brandProfileId: string): Promise<number> {
  const source = await loadSource(brandProfileId, 'trustpilot');
  const pageUrl = source.meta?.trustpilot?.page?.url ?? trustpilotUrlFromDomain(BRAND_DOMAIN);
  const { items } = await createApifyClient().dataset(INSURANCE_TRUSTPILOT).listItems({ clean: true });
  const reviews = new Map<string, NormalizedTrustpilotReview>();
  for (const raw of items) {
    const normalized = normalizeTrustpilotReviewItem(raw);
    if (normalized.kind === 'review') reviews.set(normalized.review.external_id, normalized.review);
  }
  const buildRow = (review: NormalizedTrustpilotReview) => ({
    organization_id: ADLAB_ORG_ID,
    brand_profile_id: brandProfileId,
    source_id: source.id,
    platform: 'trustpilot',
    external_id: review.external_id,
    data_type: 'review',
    scope: 'brand',
    url: review.url ?? pageUrl,
    subreddit: null,
    author_ref: review.author_ref,
    title: review.title,
    body: review.body,
    posted_at: review.posted_at,
    relevance: 'not_required',
    rating: review.rating,
    raw_ref: null,
    tags: {
      trustpilot: {
        verified: review.verified,
        ...(review.country ? { country: review.country } : {}),
        ...(review.company_reply_text ? { companyReplyText: review.company_reply_text } : {}),
        ...(review.company_reply_at ? { companyReplyAt: review.company_reply_at } : {}),
        likes: review.likes,
      },
    },
  });
  const all = [...reviews.values()];
  // Text-empty reviews store extraction-skipped, as in the processor.
  const withText = all.filter((review) => review.title || review.body).map(buildRow);
  const emptyText = all.filter((review) => !review.title && !review.body).map((review) => ({ ...buildRow(review), extraction_status: 'skipped' }));
  for (const rows of [withText, emptyText]) {
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
      const { error } = await db
        .from('brand_mentions')
        .upsert(rows.slice(i, i + UPSERT_CHUNK_SIZE), { onConflict: 'brand_profile_id,platform,external_id' });
      if (error) throw error;
    }
  }
  const meta: SourceMeta = {
    ...(source.meta ?? {}),
    a2Insurance: { datasetId: INSURANCE_TRUSTPILOT, importedAt: nowIso(), reviews: all.length },
  };
  await updateSource(source.id, { meta, status: 'synced', last_synced_at: nowIso() });
  return all.length;
}

async function printSources(brandProfileId: string): Promise<void> {
  const { data, error } = await db
    .from('brand_presence_sources')
    .select('source_type, uri, status, label, meta, last_synced_at')
    .eq('brand_profile_id', brandProfileId)
    .not('status', 'eq', 'coming_soon')
    .order('source_type');
  if (error) throw error;
  table(
    (data ?? []).map((row) => {
      const meta = (row.meta ?? {}) as SourceMeta;
      const lastRun = meta.x?.lastRun ?? meta.trustpilot?.lastRun ?? meta.tiktok?.lastRun ?? meta.instagram?.lastRun;
      return {
        source: row.uri ? `${row.source_type} ${row.uri}` : row.source_type,
        status: row.status,
        label: row.label,
        lastRun: lastRun ? `upserted ${lastRun.upserted}${lastRun.zeroItems ? ', zero items' : ''}` : '',
        error: meta.lastError?.message?.slice(0, 80) ?? '',
      };
    }),
  );
}

async function printMentionCounts(brandProfileId: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const platform of MENTION_PLATFORMS) {
    const row: Record<string, unknown> = { platform };
    let total = 0;
    for (const relevance of RELEVANCE_VALUES) {
      const n = await countRows('brand_mentions', (q) => q.eq('brand_profile_id', brandProfileId).eq('platform', platform).eq('relevance', relevance));
      row[relevance] = n;
      total += n;
    }
    row.total = total;
    rows.push(row);
  }
  console.log('\nbrand_mentions per source');
  table(rows);
  return rows;
}

// ---------------------------------------------------------------- pages

async function pages(): Promise<void> {
  const profile = await loadProfile();
  for (const page of PAGES) {
    const { data: existing, error } = await db
      .from('tracked_competitors')
      .select('id, scores')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('meta_page_id', page.pageId)
      .maybeSingle();
    if (error) throw error;
    // Meta only, tracked by page id, never a keyword (docs/PLAN.md "Locked decisions").
    const fields = {
      brand_profile_id: profile.id,
      name: page.name,
      platform: 'meta',
      keyword: null,
      page_ref: null,
      is_brand_self: page.self,
      industry: PAGE_INDUSTRY,
      status: 'active',
      updated_at: nowIso(),
    };
    const { error: writeError } = existing
      ? await db
          .from('tracked_competitors')
          .update({ ...fields, scores: { ...((existing.scores as Record<string, unknown>) ?? {}), industryOverride: true } })
          .eq('id', existing.id)
      : await db.from('tracked_competitors').insert({
          ...fields,
          organization_id: ADLAB_ORG_ID,
          meta_page_id: page.pageId,
          country: 'US',
          scores: { industryOverride: true },
        });
    if (writeError) throw writeError;
  }
  const rows = await loadPages(profile.id);
  console.log(`\n${rows.length} Meta pages for ${profile.brand_name} (brand_profile_id ${profile.id}), max ${getApifyMaxAds()} ads each\n`);
  table(
    rows.map((row) => ({
      brand: row.name,
      self: row.is_brand_self ? 'yes' : '',
      page_id: row.meta_page_id,
      country: row.country,
      industry: row.industry,
      ad_library: buildAdLibraryPageUrl(row.meta_page_id, row.country),
    })),
  );
  console.log('\nNo scrape has run. After Person A OKs these pages: npm run a2:ingest -- ads --ok');
}

// ---------------------------------------------------------------- ads

async function syncPages(label: string, rows: PageRow[]): Promise<void> {
  await drainUntilIdle(label, ADLIB_POOLS, async () => {
    for (const row of rows) {
      if (!fresh(row)) {
        log(`${row.name}: already synced ${row.last_synced_at} (--resync to scrape again)`);
        continue;
      }
      const { jobId, deduped } = await enqueueAdlibSyncJob(db, { organizationId: ADLAB_ORG_ID, competitorId: row.id });
      log(`${row.name}: sync ${deduped ? 'already queued' : 'queued'} (${jobId})`);
    }
  });
}

/** A0's Meta dataset through the copied normalizer and upsert, then the copied
 * label + embed catch-up enqueue. */
async function importAdInsurance(row: PageRow, datasetId: string): Promise<number> {
  const { items } = await createApifyClient().dataset(datasetId).listItems({ clean: true });
  const ads = (items as ApifyAdItem[])
    .map(normalizeApifyAd)
    .filter((ad): ad is NormalizedAd => ad !== null && (!ad.pageId || ad.pageId === row.meta_page_id));
  await upsertAds(db, ads, ADLAB_ORG_ID, row.id, 'meta', nowIso(), null);
  const { error } = await db
    .from('tracked_competitors')
    .update({ tags: { ...(row.tags ?? {}), a2Insurance: { datasetId, importedAt: nowIso(), ads: ads.length } } })
    .eq('id', row.id);
  if (error) throw error;
  const { labelJobs, embedJobs } = await enqueueEnrichmentCatchUp(db, { organizationId: ADLAB_ORG_ID, competitorId: row.id });
  log(`${row.name}: INSURANCE imported ${ads.length} ads from A0 dataset ${datasetId} (${labelJobs} label, ${embedJobs} embed batches)`);
  return ads.length;
}

async function ads(): Promise<void> {
  if (!flags.has('ok')) {
    throw new Error('The full Meta scrape waits for Person A to OK the pages table: run the pages step, then rerun with --ok');
  }
  if (getApifyMaxAds() !== 50) throw new Error(`APIFY_AD_LIBRARY_MAX_ADS must be 50 (got ${getApifyMaxAds()})`);
  if (process.env.LLM_FLEX_TIER?.trim() !== '0') throw new Error('LLM_FLEX_TIER must be 0 (flex queues requests)');
  const profile = await loadProfile();
  let rows = await loadPages(profile.id);
  if (rows.length !== PAGES.length) throw new Error(`Expected ${PAGES.length} pages, found ${rows.length}: run the pages step`);

  await syncPages('ads', rows);

  // Surreal is a UK brand: with --surreal-gb, an empty US sync retries in GB as a first
  // sync ('all' ads). Off by default: Person A accepted a competitor without ads (Oct 24).
  const surreal = rows.find((row) => row.name === 'Surreal')!;
  if (flags.has('surreal-gb') && (await adCount(surreal.id)) === 0 && surreal.country === 'US') {
    log('Surreal: 0 ads in US, resyncing with country GB');
    const { error } = await db.from('tracked_competitors').update({ country: 'GB', last_synced_at: null }).eq('id', surreal.id);
    if (error) throw error;
    await syncPages('ads: Surreal GB', [surreal]);
  }

  rows = await loadPages(profile.id);
  let imported = 0;
  for (const row of rows) {
    if ((await adCount(row.id)) > 0) continue;
    const datasetId = INSURANCE_ADS[row.meta_page_id];
    if (datasetId) {
      await importAdInsurance(row, datasetId);
      imported++;
    } else {
      log(`${row.name}: EMPTY, the live sync returned 0 ads and there is no insurance dataset`);
    }
  }

  // Re-enqueue label/embed for any ad a failed batch stranded, then drain.
  await drainUntilIdle(imported ? 'ads: insurance + catch-up' : 'ads: catch-up', ADLIB_POOLS, async () => {
    for (const row of rows) {
      const { labelJobs, embedJobs } = await enqueueEnrichmentCatchUp(db, { organizationId: ADLAB_ORG_ID, competitorId: row.id });
      if (labelJobs || embedJobs) log(`${row.name}: catch-up ${labelJobs} label, ${embedJobs} embed batches`);
    }
  });
  await printPages(profile.id);
}

async function printPages(brandProfileId: string): Promise<Array<PageRow & PageStats>> {
  const rows = await loadPages(brandProfileId);
  const stats: Array<PageRow & PageStats> = [];
  for (const row of rows) stats.push({ ...row, ...(await pageStats(row.id)) });
  console.log('\nlibrary_ads per page');
  table(
    stats.map((row) => ({
      brand: row.name,
      self: row.is_brand_self ? 'yes' : '',
      page_id: row.meta_page_id,
      page_name: row.meta_page_name,
      country: row.country,
      ads: row.ads,
      labelled: row.labelled,
      embedded: row.embedded,
      active: row.active,
      insurance: (row.tags?.a2Insurance as { datasetId?: string } | undefined)?.datasetId ?? '',
    })),
  );
  console.log('\nangles per page (industry food)');
  table(stats.map((row) => ({ brand: row.name, angles: row.angles })));
  return stats;
}

// ---------------------------------------------------------------- prove

/**
 * Replays the market step's own ad selection (market-processor.ts loadLabeledAds,
 * unedited): the brand's active tagged rows, minus is_brand_self, then their
 * labelled library_ads_enriched rows.
 */
async function prove(): Promise<boolean> {
  const profile = await loadProfile();
  const { data: tagged, error } = await db
    .from('tracked_competitors')
    .select('id, name, is_brand_self')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('brand_profile_id', profile.id)
    .eq('status', 'active');
  if (error) throw error;
  const taggedIds = (tagged ?? []).filter((row) => !row.is_brand_self).map((row) => String(row.id));
  const self = (tagged ?? []).find((row) => row.is_brand_self);
  if (!self) throw new Error('No is_brand_self row: run the pages step');
  if (taggedIds.length === 0) throw new Error('No competitor rows tagged with this brand: run the pages step');

  const { data: pool, error: poolError } = await db
    .from('library_ads_enriched')
    .select('id, competitor_id')
    .eq('organization_id', ADLAB_ORG_ID)
    .not('hook_archetype', 'is', null)
    .in('competitor_id', taggedIds)
    .order('id')
    .range(0, 1999);
  if (poolError) throw poolError;
  const poolByCompetitor = new Map<string, number>();
  for (const row of pool ?? []) poolByCompetitor.set(String(row.competitor_id), (poolByCompetitor.get(String(row.competitor_id)) ?? 0) + 1);

  const rows = [];
  for (const row of tagged ?? []) {
    const labelled = await countRows('library_ads_enriched', (q) =>
      q.eq('organization_id', ADLAB_ORG_ID).eq('competitor_id', row.id).not('hook_archetype', 'is', null),
    );
    rows.push({
      brand: row.name,
      is_brand_self: row.is_brand_self,
      labelled_ads: labelled,
      in_market_pool: poolByCompetitor.get(String(row.id)) ?? 0,
    });
  }
  console.log('\nThe market step\'s ad pool for this brand (market-processor.ts loadLabeledAds, replayed)');
  table(rows);
  const selfLabelled = rows.find((row) => row.is_brand_self)?.labelled_ads ?? 0;
  const checks: Array<[string, boolean]> = [
    ['Magic Spoon\'s row is not among the market step\'s tagged ids', !taggedIds.includes(String(self.id))],
    ['the pool holds 0 Magic Spoon ads', (pool ?? []).every((row) => String(row.competitor_id) !== String(self.id))],
    [`Magic Spoon has labelled ads to exclude (${selfLabelled})`, selfLabelled > 0],
    [`the pool holds the 7 competitors' labelled ads (${(pool ?? []).length})`, taggedIds.length === COMPETITOR_PAGES.length && (pool ?? []).length > 0],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  const ok = checks.every(([, passed]) => passed);
  if (!ok) process.exitCode = 1;
  return ok;
}

// ---------------------------------------------------------------- report

async function report(): Promise<void> {
  const profile = await loadProfile();
  console.log(`A2 report for ${profile.brand_name} (${profile.id}, ${profile.status})`);
  console.log('\nsources');
  await printSources(profile.id);
  const mentions = await printMentionCounts(profile.id);
  const stats = await printPages(profile.id);

  const { data: jobs, error } = await db.from('job_queue').select('type, status, error_message');
  if (error) throw error;
  const byTypeStatus = new Map<string, number>();
  for (const job of jobs ?? []) byTypeStatus.set(`${job.type} ${job.status}`, (byTypeStatus.get(`${job.type} ${job.status}`) ?? 0) + 1);
  console.log('\njob_queue');
  table([...byTypeStatus].sort().map(([key, n]) => ({ job: key, count: n })));

  const platforms = mentions.filter((row) => Number(row.total) > 0).length;
  // A page whose live sync found no ads is an accepted skip (Person A, Oct 24); a page
  // with ads that are not all labelled and embedded is not.
  const withAds = stats.filter((row) => row.ads > 0);
  const noAds = stats.filter((row) => row.ads === 0).map((row) => row.name);
  const incomplete = withAds.filter((row) => row.labelled === 0 || row.embedded === 0).map((row) => row.name);
  const self = stats.find((row) => row.is_brand_self);
  const competitors = withAds.filter((row) => !row.is_brand_self && row.labelled > 0).length;
  const checks: Array<[string, boolean]> = [
    [`brand_mentions has rows from ${platforms} sources (need 5)`, platforms >= 5],
    [`Magic Spoon's own page has labelled, embedded ads`, Boolean(self && self.labelled > 0 && self.embedded > 0)],
    [`${competitors} competitor pages have labelled, embedded ads (need 2)`, competitors >= 2],
    [`every page with ads has labelled, embedded ads${incomplete.length ? ` (missing: ${incomplete.join(', ')})` : ''}`, incomplete.length === 0],
  ];
  if (noAds.length) console.log(`
no ads, skipped: ${noAds.join(', ')}`);
  console.log('\nA2 done-when');
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

// ---------------------------------------------------------------- main

const STEPS: Record<string, () => Promise<unknown>> = { smoke, discover, sources, pages, ads, prove, report };
const run = step ? STEPS[step] : undefined;
if (!run) {
  console.error(`Usage: npm run a2:ingest -- <${Object.keys(STEPS).join('|')}> [--flags]`);
  process.exit(2);
}
try {
  await run();
} catch (error) {
  console.error(`[a2] ${step} failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadLiveBrandFacts } from '@/lib/brand-object/live-facts';
import { APIFY_AD_LIBRARY_ACTOR_ID } from '@/services/ad-library/apify-config';
import { INSTAGRAM_SCRAPER_ACTOR_ID } from '@/services/brand-presence/instagram-apify-provider';
import { REDDIT_SCRAPER_ACTOR_ID } from '@/services/brand-presence/reddit-apify-provider';
import { TIKTOK_COMMENTS_ACTOR_ID } from '@/services/brand-presence/tiktok-apify-provider';
import { TRUSTPILOT_SCRAPER_ACTOR_ID } from '@/services/brand-presence/trustpilot-apify-provider';
import { X_SCRAPER_ACTOR_ID } from '@/services/brand-presence/x-apify-provider';
import { enqueueAdlibSyncJob } from '@/services/job-processor/ad-library/queue';
import { ADLIB_SYNC_COMPETITOR_JOB_TYPE } from '@/services/job-processor/ad-library/types';
import { getBrandObjectState } from '@/services/job-processor/brand-object/state';
import {
  enqueueBrandPresenceScrape,
  enqueueInstagramComments,
  enqueueTikTokComments,
  enqueueTrustpilotReviews,
  enqueueXScrape,
  getBrandPresenceSyncJobTarget,
} from '@/services/job-processor/brand-presence/queue';
import {
  BRAND_PRESENCE_INSTAGRAM_COMMENTS_JOB_TYPE,
  BRAND_PRESENCE_SCRAPE_JOB_TYPE,
  BRAND_PRESENCE_TIKTOK_COMMENTS_JOB_TYPE,
  BRAND_PRESENCE_TRUSTPILOT_REVIEWS_JOB_TYPE,
  BRAND_PRESENCE_X_SCRAPE_JOB_TYPE,
} from '@/services/job-processor/brand-presence/types';
import { LIMITS, type IngestStatus } from '@/spacetime/src/agent_rules';
import type { AgentMode } from './agent-runtime';
import { loadBrandProfile } from './brand-profile';
import { ADLAB_ORG_ID } from './org';
import type { Spacetime } from './spacetime-http';

/*
 * Scout's data refresh (docs/AGENT_API.md "Scout": POST /ingest/refresh, GET /jobs). It plans the
 * stalest Meta pages and listening sources, and in live mode starts the copied Adcero jobs on
 * Supabase's job_queue; every job it starts (or would start) gets an ingest_job row in SpacetimeDB,
 * which /agents shows. Test mode (the default) writes only `skipped` rows and never touches
 * job_queue.
 */

export interface ActorInfo {
  /** The Apify actor, as the provider constants spell it (username~actor). */
  actor: string;
  /** Readable source name for /agents. */
  label: string;
}

/**
 * The Apify actor behind each job type Scout can start. Provider constants as they are; the ad
 * library's constant is an opaque actor id, so it gets the actor's readable name.
 */
export const ACTORS: Record<string, ActorInfo & { apifyId: string }> = {
  [ADLIB_SYNC_COMPETITOR_JOB_TYPE]: {
    actor: 'curious_coder~facebook-ads-library-scraper',
    apifyId: APIFY_AD_LIBRARY_ACTOR_ID,
    label: 'Meta ads',
  },
  [BRAND_PRESENCE_SCRAPE_JOB_TYPE]: { actor: REDDIT_SCRAPER_ACTOR_ID, apifyId: REDDIT_SCRAPER_ACTOR_ID, label: 'Reddit' },
  [BRAND_PRESENCE_X_SCRAPE_JOB_TYPE]: { actor: X_SCRAPER_ACTOR_ID, apifyId: X_SCRAPER_ACTOR_ID, label: 'X' },
  [BRAND_PRESENCE_TRUSTPILOT_REVIEWS_JOB_TYPE]: {
    actor: TRUSTPILOT_SCRAPER_ACTOR_ID,
    apifyId: TRUSTPILOT_SCRAPER_ACTOR_ID,
    label: 'Trustpilot',
  },
  [BRAND_PRESENCE_TIKTOK_COMMENTS_JOB_TYPE]: {
    actor: TIKTOK_COMMENTS_ACTOR_ID,
    apifyId: TIKTOK_COMMENTS_ACTOR_ID,
    label: 'TikTok',
  },
  [BRAND_PRESENCE_INSTAGRAM_COMMENTS_JOB_TYPE]: {
    actor: INSTAGRAM_SCRAPER_ACTOR_ID,
    apifyId: INSTAGRAM_SCRAPER_ACTOR_ID,
    label: 'Instagram',
  },
};

/** Job types whose ingest_job rows the worker's mirror follows (worker/index.ts). */
export const REFRESH_JOB_TYPES: readonly string[] = Object.keys(ACTORS);

/**
 * Listening sources A2 actually syncs. Amazon isn't ported and A2 skipped Google Maps; the
 * coming-soon types have no scraper.
 */
export const LIVE_SOURCE_TYPES = [
  'reddit_search',
  'reddit_category',
  'reddit_subreddit',
  'x',
  'trustpilot',
  'tiktok_comments',
  'instagram_comments',
] as const;

type Enqueuer = (
  db: SupabaseClient,
  params: { organizationId: string; brandProfileId: string; sourceId: string },
) => Promise<{ jobId: string; deduped: boolean }>;

/** The copied enqueuer per brand-presence job type (getBrandPresenceSyncJobTarget gives the type). */
const SOURCE_ENQUEUERS: Record<string, Enqueuer> = {
  [BRAND_PRESENCE_SCRAPE_JOB_TYPE]: enqueueBrandPresenceScrape,
  [BRAND_PRESENCE_X_SCRAPE_JOB_TYPE]: enqueueXScrape,
  [BRAND_PRESENCE_TRUSTPILOT_REVIEWS_JOB_TYPE]: enqueueTrustpilotReviews,
  [BRAND_PRESENCE_TIKTOK_COMMENTS_JOB_TYPE]: enqueueTikTokComments,
  [BRAND_PRESENCE_INSTAGRAM_COMMENTS_JOB_TYPE]: enqueueInstagramComments,
};

/** The contract's caps (docs/AGENT_API.md): pages 0..4 = 2, sources 0..3 = 1. */
export const REFRESH_LIMITS = { pages: { max: 4, default: 2 }, sources: { max: 3, default: 1 } } as const;

export const DRY_RUN_ERROR = 'dry run (test mode)';

export type RefreshKind = 'page' | 'source';

export interface PlannedJob {
  kind: RefreshKind;
  /** Readable, e.g. "Catalina Crunch · Meta ads" or "Reddit · r/keto". */
  target: string;
  actor: string;
  job_type: string;
  /** tracked_competitors.id for a page, brand_presence_sources.id for a source. */
  ref_id: string;
  last_synced_at: string | null;
}

export interface RefreshJob {
  job_id: string;
  target: string;
  actor: string;
  status: IngestStatus;
  dry: boolean;
  deduped: boolean;
}

export interface RefreshResult {
  mode: AgentMode;
  planned: PlannedJob[];
  jobs: RefreshJob[];
}

export interface RefreshInput {
  requested_by: string;
  dry?: boolean;
  targets?: Array<{ kind: RefreshKind; ref_id: string }>;
  pages?: number;
  sources?: number;
  mode: AgentMode;
}

/** A request the plan can't satisfy (an unknown target, too many targets): the route's 400. */
export class RefreshRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshRequestError';
  }
}

/** Never synced first, then the oldest sync, then the ref id, so the order is stable. */
export function stalestFirst<T extends { last_synced_at: string | null; ref_id: string }>(rows: readonly T[]): T[] {
  const time = (row: T) => (row.last_synced_at === null ? Number.NEGATIVE_INFINITY : Date.parse(row.last_synced_at));
  return [...rows].sort((a, b) => time(a) - time(b) || a.ref_id.localeCompare(b.ref_id));
}

const clampTarget = (s: string) => {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length > LIMITS.target ? `${chars.slice(0, LIMITS.target - 1).join('')}…` : chars.join('');
};

export const pageTarget = (name: string) => clampTarget(`${name} · Meta ads`);

const SOURCE_PLATFORM: Record<string, string> = {
  reddit_search: 'Reddit',
  reddit_category: 'Reddit',
  reddit_subreddit: 'Reddit',
  x: 'X',
  trustpilot: 'Trustpilot',
  tiktok_comments: 'TikTok',
  instagram_comments: 'Instagram',
};

/**
 * "Reddit · r/keto", "Reddit · brand mentions", "TikTok · @magicspooncereal": the platform, then
 * the subreddit, or what follows the label's " — ", or the brand.
 */
export function sourceTarget(source: { source_type: string; label: string | null; uri: string | null }, brandName: string): string {
  const platform = SOURCE_PLATFORM[source.source_type] ?? source.source_type;
  const label = (source.label ?? '').trim();
  let detail: string;
  if (source.source_type === 'reddit_subreddit' && source.uri) detail = source.uri.trim();
  else if (label.includes(' — ')) detail = label.slice(label.indexOf(' — ') + 3).trim();
  else detail = brandName;
  return clampTarget(`${platform} · ${detail || brandName}`);
}

interface PageRow {
  id: string;
  name: string;
  last_synced_at: string | null;
}

interface SourceRow {
  id: string;
  source_type: string;
  label: string | null;
  uri: string | null;
  last_synced_at: string | null;
}

/**
 * Every refresh candidate, stalest first: the brand's active Meta pages (Magic Spoon's own page
 * included) and its listening sources that synced before, so their handles and page config are
 * already confirmed. Read-only.
 */
export async function planRefresh(db: SupabaseClient): Promise<PlannedJob[]> {
  const profile = await loadBrandProfile(db);
  const [pages, sources] = await Promise.all([
    db
      .from('tracked_competitors')
      .select('id, name, last_synced_at')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', profile.id)
      .eq('platform', 'meta')
      .eq('status', 'active'),
    db
      .from('brand_presence_sources')
      .select('id, source_type, label, uri, last_synced_at')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', profile.id)
      .in('source_type', [...LIVE_SOURCE_TYPES])
      .not('last_synced_at', 'is', null),
  ]);
  if (pages.error) throw pages.error;
  if (sources.error) throw sources.error;
  const page = ACTORS[ADLIB_SYNC_COMPETITOR_JOB_TYPE]!;
  const planned: PlannedJob[] = ((pages.data ?? []) as PageRow[]).map((row) => ({
    kind: 'page',
    target: pageTarget(row.name),
    actor: page.actor,
    job_type: ADLIB_SYNC_COMPETITOR_JOB_TYPE,
    ref_id: String(row.id),
    last_synced_at: row.last_synced_at ?? null,
  }));
  for (const row of (sources.data ?? []) as SourceRow[]) {
    const job = getBrandPresenceSyncJobTarget(row.source_type, String(row.id));
    const actor = job && ACTORS[job.type];
    if (!job || !actor || !SOURCE_ENQUEUERS[job.type]) continue;
    planned.push({
      kind: 'source',
      target: sourceTarget(row, profile.brand_name),
      actor: actor.actor,
      job_type: job.type,
      ref_id: String(row.id),
      last_synced_at: row.last_synced_at ?? null,
    });
  }
  return stalestFirst(planned);
}

/** The jobs an execute call starts: the named targets, or the stalest `pages` and `sources`. */
export function selectTargets(planned: readonly PlannedJob[], input: Pick<RefreshInput, 'targets' | 'pages' | 'sources'>): PlannedJob[] {
  if (input.targets && input.targets.length > 0) {
    const chosen: PlannedJob[] = [];
    for (const t of input.targets) {
      const match = planned.find((p) => p.kind === t.kind && p.ref_id === t.ref_id);
      if (!match) throw new RefreshRequestError(`target ${t.kind} ${t.ref_id} is not a refresh candidate (POST with dry:true lists them)`);
      if (!chosen.includes(match)) chosen.push(match);
    }
    const pages = chosen.filter((c) => c.kind === 'page').length;
    const sources = chosen.length - pages;
    if (pages > REFRESH_LIMITS.pages.max) throw new RefreshRequestError(`at most ${REFRESH_LIMITS.pages.max} pages per refresh, got ${pages}`);
    if (sources > REFRESH_LIMITS.sources.max) throw new RefreshRequestError(`at most ${REFRESH_LIMITS.sources.max} sources per refresh, got ${sources}`);
    return chosen;
  }
  const count = (n: number | undefined, limit: { max: number; default: number }) =>
    Math.max(0, Math.min(limit.max, Math.trunc(n ?? limit.default)));
  return [
    ...planned.filter((p) => p.kind === 'page').slice(0, count(input.pages, REFRESH_LIMITS.pages)),
    ...planned.filter((p) => p.kind === 'source').slice(0, count(input.sources, REFRESH_LIMITS.sources)),
  ];
}

/** job_queue status -> ingest_job status. */
export function ingestStatusOf(queueStatus: string): IngestStatus {
  switch (queueStatus) {
    case 'processing':
    case 'completed':
    case 'failed':
    case 'pending':
      return queueStatus;
    case 'cancelled':
      return 'skipped';
    default:
      return 'pending';
  }
}

const clampError = (s: string | null | undefined) => {
  const chars = [...(s ?? '')];
  return chars.length > LIMITS.error ? `${chars.slice(0, LIMITS.error - 1).join('')}…` : chars.join('');
};

export interface IngestJobRow {
  job_id: string;
  requested_by: string;
  job_type: string;
  target: string;
  actor: string;
  status: string;
  items: number;
  error: string;
  created_at?: string;
  updated_at?: string;
}

/** ingest_job rows by id. The table is small (one row per started job), so one full read. */
export async function readIngestJobs(spacetime: Spacetime, ids?: readonly string[]): Promise<Map<string, IngestJobRow>> {
  const rows = await spacetime.sql<IngestJobRow>('SELECT * FROM ingest_job');
  const wanted = ids ? new Set(ids) : null;
  return new Map(rows.filter((r) => !wanted || wanted.has(r.job_id)).map((r) => [r.job_id, r]));
}

const upsertIngestJob = (spacetime: Spacetime, j: IngestJobRow) =>
  spacetime.call('upsert_ingest_job', [j.job_id, j.requested_by, j.job_type, j.target, j.actor, j.status, j.items, j.error]);

const reportIngestJob = (spacetime: Spacetime, r: { job_id: string; status: IngestStatus; items: number; error: string }) =>
  spacetime.call('report_ingest_job', [r.job_id, r.status, r.items, r.error]);

/** A connection, or a getter, so a dry plan never connects to SpacetimeDB. */
export type SpacetimeSource = Spacetime | (() => Promise<Spacetime>);
const resolveSpacetime = (source: SpacetimeSource): Promise<Spacetime> =>
  typeof source === 'function' ? source() : Promise.resolve(source);

export interface RefreshDeps {
  /** Overrides planRefresh (tests). */
  plan?: (db: SupabaseClient) => Promise<PlannedJob[]>;
  /** Overrides the copied enqueuers (tests). */
  enqueue?: (db: SupabaseClient, job: PlannedJob, brandProfileId: () => Promise<string>) => Promise<{ jobId: string; deduped: boolean }>;
  newId?: () => string;
}

async function enqueueLive(db: SupabaseClient, job: PlannedJob, brandProfileId: () => Promise<string>) {
  if (job.kind === 'page') return enqueueAdlibSyncJob(db, { organizationId: ADLAB_ORG_ID, competitorId: job.ref_id });
  const enqueuer = SOURCE_ENQUEUERS[job.job_type];
  if (!enqueuer) throw new Error(`no enqueuer for ${job.job_type}`);
  return enqueuer(db, { organizationId: ADLAB_ORG_ID, brandProfileId: await brandProfileId(), sourceId: job.ref_id });
}

/**
 * POST /ingest/refresh. dry: the full plan, nothing written. Test mode: `skipped` ingest_job rows
 * with random ids, no job_queue access. Live mode: the copied enqueuers, then `pending` rows (or a
 * report on a deduped job's existing row, which never downgrades a finished one), then one
 * reconcile from job_queue in case the worker already moved a job.
 */
export async function refresh(db: SupabaseClient, source: SpacetimeSource, input: RefreshInput, deps: RefreshDeps = {}): Promise<RefreshResult> {
  const planned = await (deps.plan ?? planRefresh)(db);
  if (input.dry) return { mode: input.mode, planned, jobs: [] };
  const chosen = selectTargets(planned, input);
  const spacetime = await resolveSpacetime(source);
  const newId = deps.newId ?? (() => randomUUID().toLowerCase());

  if (input.mode !== 'live') {
    const jobs: RefreshJob[] = [];
    for (const job of chosen) {
      const row = {
        job_id: newId(),
        requested_by: input.requested_by,
        job_type: job.job_type,
        target: job.target,
        actor: job.actor,
        status: 'skipped' as const,
        items: 0,
        error: DRY_RUN_ERROR,
      };
      await upsertIngestJob(spacetime, row);
      jobs.push({ job_id: row.job_id, target: job.target, actor: job.actor, status: 'skipped', dry: true, deduped: false });
    }
    return { mode: input.mode, planned: chosen, jobs };
  }

  let profileId: Promise<string> | undefined;
  const brandProfileId = () => (profileId ??= loadBrandProfile(db).then((p) => p.id));
  const existing = await readIngestJobs(spacetime);
  const jobs: RefreshJob[] = [];
  const hadRow = new Set<string>();
  for (const job of chosen) {
    const { jobId, deduped } = await (deps.enqueue ?? enqueueLive)(db, job, brandProfileId);
    const id = jobId.toLowerCase();
    if (existing.has(id)) {
      // A deduped job an earlier refresh already logged: the reconcile below reports its real
      // status through report_ingest_job, which never moves a finished row back.
      hadRow.add(id);
    } else {
      await upsertIngestJob(spacetime, {
        job_id: id,
        requested_by: input.requested_by,
        job_type: job.job_type,
        target: job.target,
        actor: job.actor,
        status: 'pending',
        items: 0,
        error: '',
      });
    }
    jobs.push({ job_id: id, target: job.target, actor: job.actor, status: 'pending', dry: false, deduped });
  }

  // Reconcile once: the worker may have claimed (or finished) a job before its row existed.
  if (jobs.length > 0) {
    const { data, error } = await db
      .from('job_queue')
      .select('id, status, error_message')
      .in(
        'id',
        jobs.map((j) => j.job_id),
      );
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; status: string; error_message: string | null }>) {
      const id = String(row.id).toLowerCase();
      const status = ingestStatusOf(row.status);
      const job = jobs.find((j) => j.job_id === id);
      if (!job) continue;
      if (status !== 'pending' || hadRow.has(id)) {
        await reportIngestJob(spacetime, { job_id: id, status, items: 0, error: clampError(row.error_message) });
      }
      job.status = status;
    }
  }
  return { mode: input.mode, planned: chosen, jobs };
}

export interface JobStatus {
  job_id: string;
  job_type: string;
  status: IngestStatus;
  error: string;
  items: number;
  target: string;
  actor: string;
  attempts: number;
}

interface QueueRow {
  id: string;
  type: string;
  status: string;
  error_message: string | null;
  attempts: number | null;
}

/**
 * GET /jobs: job_queue rows merged with their ingest_job rows (target, actor, items). `cancelled`
 * reads `skipped`; dry ids exist only in ingest_job. Unknown ids are left out. A database without
 * the agent tables still answers from job_queue.
 */
export async function jobsStatus(db: SupabaseClient, source: SpacetimeSource, ids: readonly string[]): Promise<{ jobs: JobStatus[] }> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return { jobs: [] };
  const [queue, ingest] = await Promise.all([
    db.from('job_queue').select('id, type, status, error_message, attempts').in('id', wanted),
    resolveSpacetime(source)
      .then((st) => readIngestJobs(st, wanted))
      .catch(() => new Map<string, IngestJobRow>()),
  ]);
  if (queue.error) throw queue.error;
  const byId = new Map(((queue.data ?? []) as QueueRow[]).map((row) => [String(row.id).toLowerCase(), row]));
  const jobs: JobStatus[] = [];
  for (const id of wanted) {
    const q = byId.get(id);
    const r = ingest.get(id);
    if (!q && !r) continue;
    jobs.push({
      job_id: id,
      job_type: q?.type ?? r?.job_type ?? '',
      status: q ? ingestStatusOf(q.status) : ((r?.status as IngestStatus | undefined) ?? 'pending'),
      error: q ? (q.error_message ?? '') : (r?.error ?? ''),
      items: Number(r?.items ?? 0),
      target: r?.target ?? '',
      actor: r?.actor ?? ACTORS[q?.type ?? '']?.actor ?? '',
      attempts: Number(q?.attempts ?? 0),
    });
  }
  return { jobs };
}

export interface DistillReport {
  started: false;
  reason: string;
  facts: { total: number; persona: number; market_prior: number; voc: number };
}

/**
 * POST /distill/start: a freshness report only. Distill rewrites the persona facts that every A5
 * task reads (including B's demo run), so the agents never start it tonight, forced or not.
 */
export async function distillFreshness(db: SupabaseClient, input: { force?: boolean; mode: AgentMode }): Promise<DistillReport> {
  const profile = await loadBrandProfile(db);
  const [facts, state] = await Promise.all([
    loadLiveBrandFacts(db, { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id }),
    getBrandObjectState(db, ADLAB_ORG_ID, profile.id).catch(() => null),
  ]);
  const count = {
    total: facts.length,
    persona: facts.filter((f) => f.section === 'persona').length,
    market_prior: facts.filter((f) => f.section === 'market_prior').length,
    voc: facts.filter((f) => String(f.section).startsWith('voc_')).length,
  };
  const last = state?.cursors?.personas?.lastRunAt ?? null;
  const prefix = input.mode === 'test' ? 'test mode: ' : '';
  const never = `distill never runs from the agents tonight${input.force ? ' (force ignored)' : ''}`;
  const reason =
    count.total === 0
      ? `${prefix}no live brand facts for ${profile.brand_name}; ${never}: run npm run a3:distill from a terminal`
      : `${prefix}brand context is fresh: ${count.total} facts, ${count.persona} personas, ${count.market_prior} market priors, ${count.voc} VOC` +
        `${last ? `, last distilled ${last}` : ''}; ${never}`;
  return { started: false, reason, facts: count };
}

/** A PostgREST error (Supabase), which the routes report as 502 upstream rather than 500. */
export function supabaseErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown; name?: unknown };
  const postgrest = e.name === 'PostgrestError' || ('details' in e && 'hint' in e && 'code' in e);
  return postgrest && typeof e.message === 'string' ? `Supabase: ${e.message}` : null;
}

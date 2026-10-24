import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type {
  InstagramSourceMeta,
  MentionTags,
  SourceMeta,
  SourceSyncCheckpoint,
} from '@/lib/brand-presence/types';
import {
  buildCommentsInput,
  buildPostsEnumerationInput,
  buildTrackedRecheckInput,
  canonicalInstagramPostUrl,
} from '@/services/brand-presence/instagram-actor-input';
import {
  InstagramApifyProvider,
  InstagramProviderError,
} from '@/services/brand-presence/instagram-apify-provider';
import {
  attributeCommentShortcode,
  extractInstagramPostFromItem,
  normalizeInstagramCommentItem,
  type NormalizedInstagramComment,
  type NormalizedInstagramPost,
} from '@/services/brand-presence/instagram-normalizer';
import {
  planTikTokHarvest,
  type PlannableVideo,
  type TikTokPlanConfig,
} from './tiktok-video-plan';
import { r2Service } from '@/services/r2-service';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import { enqueueExtractOrDrainCluster } from './queue';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceInstagramCommentsPayloadSchema } from './types';

const R2_BUCKET = 'adcero-ad-creatives';
const UPSERT_CHUNK_SIZE = 100;
/** Registry rows loaded for planning — well above enumerationMaxPosts, so
 * long-lived registries with drifted-out old posts still plan fully. */
const PLAN_LOAD_LIMIT = 1000;

/**
 * The generic per-post planner is the TikTok video plan — same policy, same
 * math (top-N ∪ recent-M minus floor; delta ≥ threshold with
 * clamp(ceil(delta × multiplier)) caps; cap-sorted batching). Instagram maps
 * its config onto the planner's shape: maxRepliesPerComment is a TikTok
 * actor input knob the planner never reads (the Instagram actor has no
 * replies control).
 */
const PLAN_CONFIG: TikTokPlanConfig = {
  selection: BRAND_PRESENCE_CONFIG.instagram.selection,
  backfill: {
    commentsPerVideo: BRAND_PRESENCE_CONFIG.instagram.perPostCommentCap,
    maxRepliesPerComment: 0,
  },
  refresh: BRAND_PRESENCE_CONFIG.instagram.refresh,
  maxUrlsPerRun: BRAND_PRESENCE_CONFIG.instagram.maxUrlsPerRun,
};

interface SourceRow {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_type: string;
  meta: SourceMeta | null;
}

interface PostRow {
  id: string;
  post_id: string;
  kind: 'post' | 'reel';
  url: string;
  caption: string | null;
  posted_at: string | null;
  comment_count: number;
  baseline_comment_count: number;
  comments_ingested: number;
  first_seen_at: string;
}

/**
 * brand_presence_instagram_comments — the TWO-HOP harvest (ONE JOB PER
 * SOURCE, one instagram_comments source per brand), gated on
 * meta.instagram.profile.confirmedAt (founder-confirmed OWN profile — every
 * comment is on brand content, so mentions land relevance='not_required'
 * like TikTok/Maps/Trustpilot/Amazon; the deterministic short-text filter
 * does the heavy lifting on emoji-only / tag-a-friend spam).
 *
 * ONE actor, mode-swapped inputs (the structural difference from TikTok's
 * two actors); the hops stay separate runs — provenance and budgeting
 * depend on the separation:
 *
 *   'recheck'          — refresh only: posts-mode run over the tracked
 *                        comment-rich posts' URLs (resultsLimit 1 = one
 *                        fresh post item per URL) so their commentsCounts
 *                        update without re-billing a full enumeration.
 *   'enumerate_posts'  — Hop 1a: posts-mode profile enumeration into the
 *                        registry (brand_presence_instagram_posts). On
 *                        refresh the run carries onlyPostsNewerThan (the
 *                        cheap-refresh lever — old posts' counts come from
 *                        the recheck instead).
 *   'enumerate_reels'  — Hop 1b: same, reels mode (reels are a SEPARATE
 *                        actor resultsType; the registry, planner, and tag
 *                        shape treat them uniformly via `kind`).
 *   'harvest'          — sequential Hop-2 comments-mode runs, one per
 *                        planned batch. After EACH batch's dataset is fully
 *                        ingested, per-post baselines advance for posts
 *                        that yielded ≥1 attributable item (comment items
 *                        carry postUrl — pinned live), THEN
 *                        harvestBatchIndex advances — a failed batch never
 *                        advances state for its posts, and already-committed
 *                        batches stay committed (the partial-failure
 *                        guarantee). Zero-yield posts keep their baseline
 *                        and self-correct next refresh.
 *
 * Refresh is DIFF-driven like TikTok (comments accumulate on OLD posts — a
 * date cursor cannot work; meta.cursor is committed at finalize for
 * uniformity but the refresh decision never reads it). Raw pages archive to
 * R2; crash-resume state lives in source.meta.sync (Reddit contract). A
 * zero-item SUCCESS is expected for small brands; a high short-text kill
 * rate is NORMAL for Instagram (logged per run, never alerted).
 */
export class BrandPresenceInstagramCommentsProcessor {
  private providerInstance: InstagramApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: InstagramApifyProvider,
  ) {
    this.providerInstance = provider ?? null;
  }

  private get provider(): InstagramApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new InstagramApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceInstagramCommentsPayloadSchema.parse(
      job.payload,
    );
    const { organizationId, brandProfileId, sourceId, refresh } = payload;
    const label = `[BrandPresence] InstagramComments ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source || source.source_type !== 'instagram_comments') {
      console.log(`${label}: source missing, skipping`);
      return;
    }
    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const instagram = meta.instagram;
    if (!instagram?.profile?.confirmedAt) {
      // The founder gate — never harvest unconfirmed.
      console.log(`${label}: profile not confirmed, skipping`);
      return;
    }
    if (instagram.profile.unavailable) {
      // Terminal probe state (belt over the confirm route's 409).
      console.log(
        `${label}: profile ${instagram.profile.unavailable}, skipping`,
      );
      return;
    }
    const username = instagram.profile.username;

    const scopeKey = this.buildScopeKey(username, refresh);
    let sync: SourceSyncCheckpoint;
    if (meta.sync && meta.sync.scopeKey === scopeKey) {
      sync = meta.sync;
      console.log(
        `${label}: resuming (phase=${sync.phase}, batch=${sync.harvestBatchIndex ?? 0}/${sync.harvestBatches?.length ?? 0}, runId=${sync.runId ?? 'none'}, offset=${sync.datasetOffset})`,
      );
    } else {
      sync = {
        scopeKey,
        startedAt: new Date().toISOString(),
        // The recheck only makes sense when there is a tracked registry to
        // re-read; the first backfill goes straight to enumeration.
        phase: refresh ? 'recheck' : 'enumerate_posts',
        runId: null,
        datasetId: null,
        runStartedAt: null,
        datasetOffset: 0,
        page: 0,
        maxPostedAt: meta.cursor?.lastPostedAt ?? null,
        counts: { upserted: 0, skipped: 0, shortText: 0, ownerDropped: 0 },
      };
    }
    meta.sync = sync;
    await this.persistSource(source, meta, { status: 'running' });

    try {
      if (sync.phase === 'recheck') {
        await this.runRecheck(source, sync, meta, {
          signal,
          timeoutTracker,
          label,
        });
      }
      if (sync.phase === 'enumerate_posts' || sync.phase === 'enumerate_reels') {
        await this.runEnumeration(source, sync, meta, username, refresh, {
          signal,
          timeoutTracker,
          label,
        });
      }
      if (sync.phase === 'harvest') {
        await this.runHarvest(source, sync, meta, username, {
          signal,
          timeoutTracker,
          label,
        });
      }
      await this.finalize(
        source,
        meta,
        instagram,
        sync,
        refresh,
        String(job.id),
        label,
      );
    } catch (error) {
      // Leave the checkpoint intact for timeouts (that is what resume is);
      // real failures record the error and surface status=error.
      if (!(error instanceof FunctionTimeoutError)) {
        meta.lastError = {
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        };
        await this.persistSource(source, meta, { status: 'error' }).catch(
          () => {},
        );
      }
      throw error;
    }
  }

  /**
   * Refresh-only pre-phase: one posts-mode run over the tracked comment-rich
   * posts' canonical /p/ URLs (resultsLimit 1 → one fresh post item per URL,
   * pinned live). Items flow through the SAME registry upsert as
   * enumeration, so tracked posts' comment_counts refresh without touching
   * their baselines. Skipped when nothing has been scraped yet.
   */
  private async runRecheck(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    meta: SourceMeta,
    opts: {
      signal: AbortSignal;
      timeoutTracker?: FunctionTimeoutTracker;
      label: string;
    },
  ): Promise<void> {
    if (!sync.runId) {
      const tracked = await this.loadTrackedPosts(source);
      if (tracked.length === 0) {
        console.log(`${opts.label}: no tracked posts to recheck, skipping`);
        sync.phase = 'enumerate_posts';
        await this.persistSource(source, meta);
        return;
      }
      const handle = await this.provider.startRun(
        buildTrackedRecheckInput(
          tracked.map((row) => canonicalInstagramPostUrl(row.post_id)),
        ),
      );
      sync.runId = handle.runId;
      sync.datasetId = handle.datasetId;
      sync.runStartedAt = new Date().toISOString();
      sync.datasetOffset = 0;
      // Persist in the very next await — that window is the only
      // unavoidable orphan.
      await this.persistSource(source, meta);
      console.log(
        `${opts.label}: started recheck run ${handle.runId} (${tracked.length} tracked posts)`,
      );
    }

    await this.ingestPostItems(source, sync, meta, 'recheck', opts);

    sync.phase = 'enumerate_posts';
    sync.runId = null;
    sync.datasetId = null;
    sync.runStartedAt = null;
    sync.datasetOffset = 0;
    await this.persistSource(source, meta);
    if (opts.timeoutTracker?.shouldStop()) {
      throw new FunctionTimeoutError(
        'Function timeout - will resume on next cron',
      );
    }
  }

  /**
   * Hop 1: enumerate the profile's posts AND reels into the registry (two
   * sequential mode runs — reels are a separate actor resultsType), then
   * compute and persist the Hop-2 batch plan. On refresh both runs carry
   * onlyPostsNewerThan so old posts are not re-billed (their fresh counts
   * came from the recheck).
   */
  private async runEnumeration(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    meta: SourceMeta,
    username: string,
    refresh: boolean,
    opts: {
      signal: AbortSignal;
      timeoutTracker?: FunctionTimeoutTracker;
      label: string;
    },
  ): Promise<void> {
    const newerThan = refresh
      ? this.refreshEnumerationFloor(meta.instagram)
      : null;

    while (
      sync.phase === 'enumerate_posts' ||
      sync.phase === 'enumerate_reels'
    ) {
      const mode = sync.phase === 'enumerate_posts' ? 'posts' : 'reels';

      if (!sync.runId) {
        const handle = await this.provider.startRun(
          buildPostsEnumerationInput(username, { mode, newerThan }),
        );
        sync.runId = handle.runId;
        sync.datasetId = handle.datasetId;
        sync.runStartedAt = new Date().toISOString();
        sync.datasetOffset = 0;
        await this.persistSource(source, meta);
        console.log(
          `${opts.label}: started ${mode} enumeration run ${handle.runId}${newerThan ? ` (newerThan=${newerThan})` : ''}`,
        );
      }

      await this.ingestPostItems(source, sync, meta, mode, opts);

      sync.phase =
        sync.phase === 'enumerate_posts' ? 'enumerate_reels' : 'harvest';
      sync.runId = null;
      sync.datasetId = null;
      sync.runStartedAt = null;
      sync.datasetOffset = 0;
      await this.persistSource(source, meta);
      if (
        sync.phase !== 'harvest' &&
        opts.timeoutTracker?.shouldStop()
      ) {
        throw new FunctionTimeoutError(
          'Function timeout - will resume on next cron',
        );
      }
    }

    // The treasure map is fresh — plan the harvest and persist it so a
    // resumed job re-enters with the exact same batches. Plannable urls are
    // the canonical /p/ form (comments mode only accepts post URLs; reels
    // shortcodes serve under /p/ too — pinned live).
    const registry = await this.loadRegistry(source);
    const plannable: PlannableVideo[] = registry.map((row) => ({
      videoId: row.post_id,
      url: canonicalInstagramPostUrl(row.post_id),
      postedAt: row.posted_at,
      commentCount: row.comment_count,
      baselineCommentCount: row.baseline_comment_count,
      isNew: row.first_seen_at >= sync.startedAt,
    }));
    const batches = planTikTokHarvest(plannable, { refresh }, PLAN_CONFIG);
    sync.harvestBatches = batches.map((batch) => ({
      postIds: batch.videoIds,
      urls: batch.urls,
      commentsPerPost: batch.commentsPerPost,
    }));
    sync.harvestBatchIndex = 0;
    sync.phase = 'harvest';
    await this.persistSource(source, meta);
    console.log(
      `${opts.label}: enumerated ${sync.harvestPostsEnumerated ?? 0} posts -> ${batches.reduce((total, batch) => total + batch.videoIds.length, 0)} selected in ${batches.length} batches (refresh=${refresh})`,
    );
  }

  /**
   * Shared post-item ingest loop for the recheck and both enumeration
   * phases: await the checkpointed run, page its dataset, upsert registry
   * rows (partitioned — see upsertPosts), and freshen the confirm card's
   * postsCount as a side signal.
   */
  private async ingestPostItems(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    meta: SourceMeta,
    mode: 'posts' | 'reels' | 'recheck',
    opts: {
      signal: AbortSignal;
      timeoutTracker?: FunctionTimeoutTracker;
      label: string;
    },
  ): Promise<void> {
    const { datasetPageSize } = BRAND_PRESENCE_CONFIG;

    const outcome = await awaitRunCompletion({
      provider: this.provider,
      runId: sync.runId!,
      runStartedAt: sync.runStartedAt ?? sync.startedAt,
      signal: opts.signal,
      timeoutTracker: opts.timeoutTracker,
      label: opts.label,
    });
    if (outcome.outcome === 'failed') {
      // Clear the dead run so a job retry starts a fresh one (the wedged
      // path already aborted it).
      sync.runId = null;
      sync.datasetId = null;
      sync.runStartedAt = null;
      await this.persistSource(source, meta);
      throw new InstagramProviderError(
        `Instagram ${mode} run failed${outcome.wedged ? ' (wedged)' : ''}`,
        { retryable: outcome.retryable },
      );
    }
    if (!sync.datasetId) {
      throw new InstagramProviderError(
        `Run ${sync.runId} succeeded but no datasetId was checkpointed`,
        { retryable: true },
      );
    }

    for (;;) {
      if (opts.signal.aborted) throw new Error('Brand presence job aborted');

      const items = await this.provider.listDatasetItems(
        sync.datasetId,
        sync.datasetOffset,
        datasetPageSize,
      );
      if (items.length === 0) break;

      await this.storeRawPage(source, sync, items);

      const posts: NormalizedInstagramPost[] = [];
      for (const raw of items) {
        const normalized = extractInstagramPostFromItem(
          raw,
          mode === 'reels' ? 'reels' : 'posts',
        );
        if (normalized.kind === 'post') posts.push(normalized.post);
      }

      await this.upsertPosts(source, posts);
      sync.harvestPostsEnumerated =
        (sync.harvestPostsEnumerated ?? 0) + posts.length;
      sync.datasetOffset += items.length;
      sync.page += 1;
      await this.persistSource(source, meta);

      if (items.length < datasetPageSize) break;
      if (opts.timeoutTracker?.shouldStop()) {
        throw new FunctionTimeoutError(
          'Function timeout - will resume on next cron',
        );
      }
    }
  }

  /** Hop 2: sequential batched comments-mode runs off the persisted plan. */
  private async runHarvest(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    meta: SourceMeta,
    username: string,
    opts: {
      signal: AbortSignal;
      timeoutTracker?: FunctionTimeoutTracker;
      label: string;
    },
  ): Promise<void> {
    const { datasetPageSize } = BRAND_PRESENCE_CONFIG;
    const batches = sync.harvestBatches ?? [];

    while ((sync.harvestBatchIndex ?? 0) < batches.length) {
      if (opts.signal.aborted) throw new Error('Brand presence job aborted');
      const batchIndex = sync.harvestBatchIndex ?? 0;
      const batch = batches[batchIndex];

      if (!sync.runId) {
        const handle = await this.provider.startRun(
          buildCommentsInput({
            urls: batch.urls,
            commentsPerPost: batch.commentsPerPost,
          }),
        );
        sync.runId = handle.runId;
        sync.datasetId = handle.datasetId;
        sync.runStartedAt = new Date().toISOString();
        sync.datasetOffset = 0;
        sync.harvestBatchYields = {};
        await this.persistSource(source, meta);
        console.log(
          `${opts.label}: started comments run ${handle.runId} (batch ${batchIndex + 1}/${batches.length}, ${batch.urls.length} posts, cap=${batch.commentsPerPost})`,
        );
      }

      const outcome = await awaitRunCompletion({
        provider: this.provider,
        runId: sync.runId,
        runStartedAt: sync.runStartedAt ?? sync.startedAt,
        signal: opts.signal,
        timeoutTracker: opts.timeoutTracker,
        label: opts.label,
      });
      if (outcome.outcome === 'failed') {
        // Keep harvestBatchIndex — committed batches stay committed; the
        // retry re-runs only THIS batch, and its posts' baselines never
        // advanced (the partial-failure guarantee).
        sync.runId = null;
        sync.datasetId = null;
        sync.runStartedAt = null;
        sync.datasetOffset = 0;
        delete sync.harvestBatchYields;
        await this.persistSource(source, meta);
        throw new InstagramProviderError(
          `Instagram comments run failed (batch ${batchIndex + 1}/${batches.length}${outcome.wedged ? ', wedged' : ''})`,
          { retryable: outcome.retryable },
        );
      }
      if (!sync.datasetId) {
        throw new InstagramProviderError(
          `Run ${sync.runId} succeeded but no datasetId was checkpointed`,
          { retryable: true },
        );
      }

      // The registry join: shortcode -> url/caption/kind (comments-mode
      // items carry no caption) + the plan-time comment_count the baseline
      // advances to.
      const postRows = await this.loadBatchPosts(source, batch.postIds);
      const lookup = new Map(
        postRows.map((row) => [
          row.post_id,
          { url: row.url, caption: row.caption, kind: row.kind },
        ]),
      );
      const batchPostIds = new Set(batch.postIds);
      const yields = (sync.harvestBatchYields ??= {});

      for (;;) {
        if (opts.signal.aborted) throw new Error('Brand presence job aborted');

        const items = await this.provider.listDatasetItems(
          sync.datasetId,
          sync.datasetOffset,
          datasetPageSize,
        );
        if (items.length === 0) break;

        const rawRef = await this.storeRawPage(source, sync, items);

        const mentions: NormalizedInstagramComment[] = [];
        for (const raw of items) {
          // Yield accounting first — ANY item attributable to a batch post
          // (kept, owner-dropped, or short) proves the scrape covered it.
          const attributedId = attributeCommentShortcode(raw);
          if (attributedId && batchPostIds.has(attributedId)) {
            yields[attributedId] = (yields[attributedId] ?? 0) + 1;
          }

          const normalized = normalizeInstagramCommentItem(raw, {
            ownerUsername: username,
            postLookup: (shortcode) => lookup.get(shortcode),
          });
          if (normalized.kind !== 'mention') {
            sync.counts.skipped += 1;
            if (normalized.reason === 'owner-authored comment') {
              sync.counts.ownerDropped =
                (sync.counts.ownerDropped ?? 0) + 1;
            }
            continue;
          }
          mentions.push(normalized.mention);
          if (
            normalized.mention.posted_at &&
            (!sync.maxPostedAt ||
              normalized.mention.posted_at > sync.maxPostedAt)
          ) {
            sync.maxPostedAt = normalized.mention.posted_at;
          }
        }

        const { written, shortText } = await this.upsertMentions(
          source,
          mentions,
          rawRef,
        );
        sync.counts.upserted += written;
        sync.counts.shortText = (sync.counts.shortText ?? 0) + shortText;
        sync.datasetOffset += items.length;
        sync.page += 1;
        await this.persistSource(source, meta);

        if (items.length < datasetPageSize) break;
        if (opts.timeoutTracker?.shouldStop()) {
          throw new FunctionTimeoutError(
            'Function timeout - will resume on next cron',
          );
        }
      }

      // Batch commit: advance per-post state ONLY for posts that yielded.
      // baseline_comment_count moves to the PLAN-TIME enumerated count (the
      // value this run's delta was computed against). Zero-yield posts are
      // untouched — their delta re-crosses the threshold next refresh.
      // Replays after a crash inside this window are tolerable: the baseline
      // write is idempotent (same plan-time value); comments_ingested is
      // informational and may over-count by one crash window.
      const nowIso = new Date().toISOString();
      let scrapedThisBatch = 0;
      for (const row of postRows) {
        const yielded = yields[row.post_id] ?? 0;
        if (yielded < 1) continue;
        const { error } = await this._db
          .from('brand_presence_instagram_posts')
          .update({
            baseline_comment_count: row.comment_count,
            comments_ingested: row.comments_ingested + yielded,
            last_scraped_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', row.id)
          .eq('organization_id', source.organization_id);
        if (error) throw error;
        scrapedThisBatch += 1;
      }

      sync.harvestPostsScraped =
        (sync.harvestPostsScraped ?? 0) + scrapedThisBatch;
      sync.harvestBatchIndex = batchIndex + 1;
      sync.runId = null;
      sync.datasetId = null;
      sync.runStartedAt = null;
      sync.datasetOffset = 0;
      delete sync.harvestBatchYields;
      await this.persistSource(source, meta);
      console.log(
        `${opts.label}: batch ${batchIndex + 1}/${batches.length} committed (${scrapedThisBatch}/${batch.postIds.length} posts yielded)`,
      );

      if (opts.timeoutTracker?.shouldStop()) {
        throw new FunctionTimeoutError(
          'Function timeout - will resume on next cron',
        );
      }
    }
  }

  /**
   * Registry upsert, partitioned so existing rows never carry
   * baseline_comment_count / comments_ingested (the per-post scrape state a
   * re-enumeration or recheck must not touch) while fresh rows seed the
   * baseline at the first-seen count.
   */
  private async upsertPosts(
    source: SourceRow,
    posts: NormalizedInstagramPost[],
  ): Promise<void> {
    if (posts.length === 0) return;

    // In-page dedupe (defensive — the actor shouldn't repeat posts).
    const byId = new Map<string, NormalizedInstagramPost>();
    for (const post of posts) {
      if (!byId.has(post.post_id)) byId.set(post.post_id, post);
    }
    const deduped = [...byId.values()];
    const nowIso = new Date().toISOString();

    for (let i = 0; i < deduped.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = deduped.slice(i, i + UPSERT_CHUNK_SIZE);
      const postIds = chunk.map((post) => post.post_id);

      const { data: existingRows, error: existingError } = await this._db
        .from('brand_presence_instagram_posts')
        .select('post_id')
        .eq('organization_id', source.organization_id)
        .eq('brand_profile_id', source.brand_profile_id)
        .in('post_id', postIds);
      if (existingError) throw existingError;
      const existingIds = new Set(
        (existingRows ?? []).map((row) => String(row.post_id)),
      );

      const buildRow = (post: NormalizedInstagramPost) => ({
        organization_id: source.organization_id,
        brand_profile_id: source.brand_profile_id,
        source_id: source.id,
        post_id: post.post_id,
        kind: post.kind,
        url: post.url,
        caption: post.caption,
        posted_at: post.posted_at,
        comment_count: post.comment_count,
        last_enumerated_at: nowIso,
        updated_at: nowIso,
      });

      const fresh = chunk.filter((post) => !existingIds.has(post.post_id));
      const existing = chunk.filter((post) =>
        existingIds.has(post.post_id),
      );

      const upsert = async (rows: Record<string, unknown>[]) => {
        if (rows.length === 0) return;
        const { error } = await this._db
          .from('brand_presence_instagram_posts')
          .upsert(rows, { onConflict: 'brand_profile_id,post_id' });
        if (error) throw error;
      };

      await upsert(
        fresh.map((post) => ({
          ...buildRow(post),
          // The delta baseline starts at the first-seen count — growth from
          // here is what earns a Hop-2 visit.
          baseline_comment_count: post.comment_count,
        })),
      );
      await upsert(existing.map(buildRow));
    }
  }

  private async upsertMentions(
    source: SourceRow,
    mentions: NormalizedInstagramComment[],
    rawRef: string | null,
  ): Promise<{ written: number; shortText: number }> {
    if (mentions.length === 0) return { written: 0, shortText: 0 };

    // In-batch dedupe by external_id (first wins).
    const byExternalId = new Map<string, NormalizedInstagramComment>();
    for (const mention of mentions) {
      if (!byExternalId.has(mention.external_id)) {
        byExternalId.set(mention.external_id, mention);
      }
    }
    const deduped = [...byExternalId.values()];

    let written = 0;
    let shortText = 0;
    for (let i = 0; i < deduped.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = deduped.slice(i, i + UPSERT_CHUNK_SIZE);
      const externalIds = chunk.map((mention) => mention.external_id);

      // Pre-read existing rows: replays must never clobber extract-pass tags
      // (tags.insight) or reset a decided relevance/extraction status.
      const { data: existingRows, error: existingError } = await this._db
        .from('brand_mentions')
        .select('external_id, tags')
        .eq('organization_id', source.organization_id)
        .eq('brand_profile_id', source.brand_profile_id)
        .eq('platform', 'instagram')
        .in('external_id', externalIds);
      if (existingError) throw existingError;
      const existingTags = new Map(
        (existingRows ?? []).map((row) => [
          String(row.external_id),
          (row.tags as MentionTags | null) ?? {},
        ]),
      );

      const buildRow = (mention: NormalizedInstagramComment) => ({
        organization_id: source.organization_id,
        brand_profile_id: source.brand_profile_id,
        source_id: source.id,
        platform: 'instagram',
        external_id: mention.external_id,
        data_type: 'comment',
        scope: 'brand',
        // The mention url is the comment's own permalink (falling back to
        // the post URL); the caption rides parent_title as extraction
        // context.
        url: mention.url,
        subreddit: null,
        author_ref: mention.author_ref,
        title: null,
        body: mention.body,
        posted_at: mention.posted_at,
        parent_external_id: mention.post_id,
        parent_title: mention.parent_title,
        rating: null,
        raw_ref: rawRef,
        tags: {
          ...existingTags.get(mention.external_id),
          instagram: {
            postId: mention.post_id,
            postUrl: mention.post_url,
            kind: mention.post_kind,
            likes: mention.likes,
            replyCount: mention.reply_count,
          },
        },
      });

      // Partitioned upserts (bulk rows must share one column set); existing
      // rows OMIT relevance/extraction_status entirely so a replay never
      // resets a decided verdict or a skipped/done extraction.
      const existing = chunk.filter((m) => existingTags.has(m.external_id));
      const fresh = chunk.filter((m) => !existingTags.has(m.external_id));
      // "🔥🔥" / tag-a-friend comments store for provenance but never reach
      // any LLM — the founder-confirmed own profile means no relevance gate,
      // so the short-text filter is the only spend control.
      const freshShort = fresh.filter((m) => m.short_text);
      const freshKept = fresh.filter((m) => !m.short_text);

      const upsert = async (rows: Record<string, unknown>[]) => {
        if (rows.length === 0) return;
        const { error } = await this._db
          .from('brand_mentions')
          .upsert(rows, { onConflict: 'brand_profile_id,platform,external_id' });
        if (error) throw error;
        written += rows.length;
      };

      await upsert(
        freshKept.map((m) => ({
          ...buildRow(m),
          // Founder-confirmed own profile IS the ownership gate — no
          // relevance LLM (TikTok/Maps/Trustpilot/Amazon class).
          relevance: 'not_required',
          // extraction_status intentionally omitted — defaults 'pending'.
        })),
      );
      await upsert(
        freshShort.map((m) => ({
          ...buildRow(m),
          relevance: 'not_required',
          extraction_status: 'skipped',
        })),
      );
      await upsert(existing.map(buildRow));
      shortText += freshShort.length;
    }
    return { written, shortText };
  }

  /** Best-effort raw page archive (Layer-2 key convention). */
  private async storeRawPage(
    source: SourceRow,
    sync: SourceSyncCheckpoint,
    items: unknown[],
  ): Promise<string | null> {
    const key = `brand-presence/${source.organization_id}/${source.brand_profile_id}/${source.id}/instagram-${sync.phase}-${sync.startedAt}-page${sync.page}.json`;
    try {
      await r2Service.uploadFile(
        R2_BUCKET,
        key,
        JSON.stringify(items),
        'application/json',
        { source: 'brand-presence-instagram' },
      );
      return key;
    } catch (error) {
      console.warn(
        `[BrandPresence] Failed to store raw page ${key}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  /** Commit cursor + last-run stats + the next refresh's enumeration floor,
   * clear the checkpoint, mark synced, and hand the new not_required
   * mentions straight to phrase extraction (the relevance gate never
   * touches this source). */
  /** `currentJobId` is load-bearing, not bookkeeping: an Instagram comments
   * job that finishes LAST with zero extract-eligible mentions owns the final
   * theme-rebuild drain check, and that check must exclude this job's own
   * still-`processing` row. Missing it stranded 497 phrases in prod
   * (2026-09-16, ABF Ohana) — see `enqueueExtractOrDrainCluster`. */
  private async finalize(
    source: SourceRow,
    meta: SourceMeta,
    instagram: InstagramSourceMeta,
    sync: SourceSyncCheckpoint,
    refresh: boolean,
    currentJobId: string,
    label: string,
  ): Promise<void> {
    const zeroItems = sync.counts.upserted === 0 && sync.counts.skipped === 0;
    if (zeroItems) {
      // Expected for small brands (few comment-worthy posts is normal) —
      // recorded in meta.instagram.lastRun for the panel; the loud log stays
      // as the breakage detector for brands that normally have volume.
      console.warn(`${label}: ZERO comment items returned across all batches`);
    }
    if (sync.maxPostedAt) {
      meta.cursor = { lastPostedAt: sync.maxPostedAt };
    }
    const postsPlanned = (sync.harvestBatches ?? []).reduce(
      (total, batch) => total + batch.postIds.length,
      0,
    );
    meta.instagram = {
      ...instagram,
      // The next refresh's onlyPostsNewerThan floor — when this pass
      // STARTED, so posts published mid-run are re-seen next time.
      lastEnumeratedAt: sync.startedAt,
      lastRun: {
        finishedAt: new Date().toISOString(),
        refresh,
        postsEnumerated: sync.harvestPostsEnumerated ?? 0,
        postsPlanned,
        postsScraped: sync.harvestPostsScraped ?? 0,
        upserted: sync.counts.upserted,
        skipped: sync.counts.skipped,
        skippedShort: sync.counts.shortText ?? 0,
        ownerDropped: sync.counts.ownerDropped ?? 0,
        zeroItems,
      },
    };
    delete meta.sync;
    delete meta.lastError;
    await this.persistSource(source, meta, {
      status: 'synced',
      last_synced_at: new Date().toISOString(),
    });

    // Everything lands not_required, so relevance drain-finalize never fires
    // for this source — enqueue phrase extraction directly, or drain to the
    // final theme rebuild when there is nothing left to extract.
    const { extractIds } = await enqueueExtractOrDrainCluster(this._db, {
      organizationId: source.organization_id,
      brandProfileId: source.brand_profile_id,
      excludeJobId: currentJobId,
    });

    const total = sync.counts.upserted + sync.counts.skipped;
    const killRate =
      total > 0
        ? Math.round(
            (((sync.counts.shortText ?? 0) + sync.counts.skipped) / total) *
              100,
          )
        : 0;
    // High kill rates are NORMAL for Instagram comments — log, never alert.
    console.log(
      `${label}: synced ${sync.counts.upserted} mentions (${sync.counts.shortText ?? 0} short, ${sync.counts.ownerDropped ?? 0} owner-dropped, ${sync.counts.skipped} skipped; ~${killRate}% filtered — normal for Instagram) across ${sync.harvestPostsScraped ?? 0}/${postsPlanned} planned posts -> ${extractIds.length} eligible for extraction`,
    );
  }

  private buildScopeKey(username: string, refresh: boolean): string {
    const { instagram } = BRAND_PRESENCE_CONFIG;
    return createHash('sha256')
      .update(
        JSON.stringify({
          username,
          refresh,
          enumerationMaxPosts: instagram.enumerationMaxPosts,
          recheckMaxPosts: instagram.recheckMaxPosts,
          selection: instagram.selection,
          perPostCommentCap: instagram.perPostCommentCap,
          refreshCfg: instagram.refresh,
          maxUrlsPerRun: instagram.maxUrlsPerRun,
        }),
      )
      .digest('hex');
  }

  /** Refresh enumeration floor: lastEnumeratedAt minus the overlap
   * allowance, day-sliced UTC (the actor's onlyPostsNewerThan grammar).
   * Null (full enumeration) when this brand never finished a pass. */
  private refreshEnumerationFloor(
    instagram: InstagramSourceMeta | undefined,
  ): string | null {
    const lastEnumeratedAt = instagram?.lastEnumeratedAt;
    if (!lastEnumeratedAt) return null;
    const parsed = Date.parse(lastEnumeratedAt);
    if (Number.isNaN(parsed)) return null;
    const floor = new Date(
      parsed -
        BRAND_PRESENCE_CONFIG.instagram.refreshOverlapDays * 24 * 60 * 60 * 1000,
    );
    return floor.toISOString().slice(0, 10);
  }

  /** The tracked comment-rich posts (already harvested at least once) whose
   * fresh counts the recheck re-reads — capped, comment-richest first. */
  private async loadTrackedPosts(source: SourceRow): Promise<PostRow[]> {
    const { data, error } = await this._db
      .from('brand_presence_instagram_posts')
      .select(
        'id, post_id, kind, url, caption, posted_at, comment_count, baseline_comment_count, comments_ingested, first_seen_at',
      )
      .eq('organization_id', source.organization_id)
      .eq('brand_profile_id', source.brand_profile_id)
      .not('last_scraped_at', 'is', null)
      .order('comment_count', { ascending: false })
      .limit(BRAND_PRESENCE_CONFIG.instagram.recheckMaxPosts);
    if (error) throw error;
    return (data ?? []) as PostRow[];
  }

  /** All registry rows for this brand (the planner's input). */
  private async loadRegistry(source: SourceRow): Promise<PostRow[]> {
    const { data, error } = await this._db
      .from('brand_presence_instagram_posts')
      .select(
        'id, post_id, kind, url, caption, posted_at, comment_count, baseline_comment_count, comments_ingested, first_seen_at',
      )
      .eq('organization_id', source.organization_id)
      .eq('brand_profile_id', source.brand_profile_id)
      .order('comment_count', { ascending: false })
      .limit(PLAN_LOAD_LIMIT);
    if (error) throw error;
    return (data ?? []) as PostRow[];
  }

  /** The current batch's registry rows (lookup + plan-time counts). */
  private async loadBatchPosts(
    source: SourceRow,
    postIds: string[],
  ): Promise<PostRow[]> {
    const { data, error } = await this._db
      .from('brand_presence_instagram_posts')
      .select(
        'id, post_id, kind, url, caption, posted_at, comment_count, baseline_comment_count, comments_ingested, first_seen_at',
      )
      .eq('organization_id', source.organization_id)
      .eq('brand_profile_id', source.brand_profile_id)
      .in('post_id', postIds);
    if (error) throw error;
    return (data ?? []) as PostRow[];
  }

  private async loadSource(
    organizationId: string,
    brandProfileId: string,
    sourceId: string,
  ): Promise<SourceRow | null> {
    const { data, error } = await this._db
      .from('brand_presence_sources')
      .select('id, organization_id, brand_profile_id, source_type, meta')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .eq('id', sourceId)
      .maybeSingle();
    if (error) throw error;
    return (data as SourceRow | null) ?? null;
  }

  private async persistSource(
    source: SourceRow,
    meta: SourceMeta,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this._db
      .from('brand_presence_sources')
      .update({
        meta,
        updated_at: new Date().toISOString(),
        ...extra,
      })
      .eq('id', source.id)
      .eq('organization_id', source.organization_id);
    if (error) throw error;
  }
}

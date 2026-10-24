import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type {
  MentionTags,
  SourceMeta,
  SourceSyncCheckpoint,
  TikTokSourceMeta,
} from '@/lib/brand-presence/types';
import {
  buildCommentsInput,
  buildProfileEnumerationInput,
} from '@/services/brand-presence/tiktok-actor-input';
import {
  TikTokApifyProvider,
  TikTokProviderError,
} from '@/services/brand-presence/tiktok-apify-provider';
import {
  attributeCommentVideoId,
  extractProfileCardFromItem,
  extractVideoFromItem,
  normalizeTikTokCommentItem,
  type NormalizedTikTokComment,
  type NormalizedTikTokVideo,
} from '@/services/brand-presence/tiktok-normalizer';
import {
  planTikTokHarvest,
  type PlannableVideo,
} from './tiktok-video-plan';
import { r2Service } from '@/services/r2-service';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import { enqueueExtractOrDrainCluster } from './queue';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceTikTokCommentsPayloadSchema } from './types';

const R2_BUCKET = 'adcero-ad-creatives';
const UPSERT_CHUNK_SIZE = 100;
/** Registry rows loaded for planning — well above enumerationMaxVideos, so
 * long-lived registries with drifted-out old videos still plan fully. */
const PLAN_LOAD_LIMIT = 1000;

interface SourceRow {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_type: string;
  meta: SourceMeta | null;
}

interface VideoRow {
  id: string;
  video_id: string;
  url: string;
  caption: string | null;
  posted_at: string | null;
  comment_count: number;
  baseline_comment_count: number;
  comments_ingested: number;
  first_seen_at: string;
}

/**
 * brand_presence_tiktok_comments — the TWO-HOP harvest (ONE JOB PER SOURCE,
 * one tiktok_comments source per brand), gated on
 * meta.tiktok.profile.confirmedAt (founder-confirmed OWN profile — every
 * comment is on brand content, so mentions land relevance='not_required'
 * like Maps/Trustpilot/Amazon; the deterministic short-text filter does the
 * heavy lifting).
 *
 *   phase 'enumerate' — Hop 1 (profile scraper) refreshes the per-video
 *                       registry (brand_presence_tiktok_videos) with fresh
 *                       commentCounts — the treasure map. The planner then
 *                       selects videos worth a Hop-2 visit (backfill:
 *                       top-N ∪ recent-M minus floor; refresh: commentCount
 *                       delta ≥ threshold vs the per-video baseline, new
 *                       videos via the backfill policy) and buckets them
 *                       into ≤maxUrlsPerRun batches persisted on the
 *                       checkpoint. NEVER all videos.
 *   phase 'harvest'   — sequential Hop-2 (comments scraper) runs, one per
 *                       batch. After EACH batch's dataset is fully ingested,
 *                       per-video baselines advance for videos that yielded
 *                       ≥1 dataset item (conditional row updates), THEN
 *                       tiktokBatchIndex advances — a failed batch never
 *                       advances state for its videos, and already-committed
 *                       batches stay committed (the partial-failure
 *                       guarantee). Zero-yield videos keep their baseline
 *                       and self-correct next refresh.
 *
 * Refresh runs the SAME two phases — the refresh flag only changes the
 * planner (diff-driven: comments accumulate on OLD videos, so a date cursor
 * cannot work; meta.cursor is committed at finalize for uniformity but the
 * refresh decision never reads it). Raw pages archive to R2; crash-resume
 * state lives in source.meta.sync (Reddit contract: persist runId/datasetId
 * immediately after start, resume by scopeKey, page the dataset by offset).
 * A zero-item SUCCESS is expected for small brands; a 40-60% short-text
 * kill rate is NORMAL for TikTok (logged per run, never alerted).
 */
export class BrandPresenceTikTokCommentsProcessor {
  private providerInstance: TikTokApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: TikTokApifyProvider,
  ) {
    this.providerInstance = provider ?? null;
  }

  private get provider(): TikTokApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new TikTokApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceTikTokCommentsPayloadSchema.parse(
      job.payload,
    );
    const { organizationId, brandProfileId, sourceId, refresh } = payload;
    const label = `[BrandPresence] TikTokComments ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source || source.source_type !== 'tiktok_comments') {
      console.log(`${label}: source missing, skipping`);
      return;
    }
    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const tiktok = meta.tiktok;
    if (!tiktok?.profile?.confirmedAt) {
      // The founder gate — never harvest unconfirmed.
      console.log(`${label}: profile not confirmed, skipping`);
      return;
    }
    if (tiktok.profile.unavailable) {
      // Terminal probe state (belt over the confirm route's 409).
      console.log(
        `${label}: profile ${tiktok.profile.unavailable}, skipping`,
      );
      return;
    }
    const username = tiktok.profile.username;

    const scopeKey = this.buildScopeKey(username, refresh);
    let sync: SourceSyncCheckpoint;
    if (meta.sync && meta.sync.scopeKey === scopeKey) {
      sync = meta.sync;
      console.log(
        `${label}: resuming (phase=${sync.phase}, batch=${sync.tiktokBatchIndex ?? 0}/${sync.tiktokBatches?.length ?? 0}, runId=${sync.runId ?? 'none'}, offset=${sync.datasetOffset})`,
      );
    } else {
      sync = {
        scopeKey,
        startedAt: new Date().toISOString(),
        phase: 'enumerate',
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
      if (sync.phase === 'enumerate') {
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
        tiktok,
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
   * Hop 1: enumerate the profile's videos into the registry, then compute
   * and persist the Hop-2 batch plan. The registry upsert is partitioned
   * (x-processor precedent): fresh rows set baseline_comment_count to the
   * first-seen count; existing rows NEVER carry the baseline column, so
   * re-enumeration only refreshes comment_count — the delta driver — and
   * leaves per-video scrape state untouched.
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
    const { datasetPageSize } = BRAND_PRESENCE_CONFIG;

    if (!sync.runId) {
      const handle = await this.provider.startProfileRun(
        buildProfileEnumerationInput(username),
      );
      sync.runId = handle.runId;
      sync.datasetId = handle.datasetId;
      sync.runStartedAt = new Date().toISOString();
      sync.datasetOffset = 0;
      // Persist in the very next await — that window is the only
      // unavoidable orphan.
      await this.persistSource(source, meta);
      console.log(`${opts.label}: started enumeration run ${handle.runId}`);
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
      // Clear the dead run so a job retry starts a fresh one (the wedged
      // path already aborted it).
      sync.runId = null;
      sync.datasetId = null;
      sync.runStartedAt = null;
      await this.persistSource(source, meta);
      throw new TikTokProviderError(
        `TikTok enumeration run failed${outcome.wedged ? ' (wedged)' : ''}`,
        { retryable: outcome.retryable },
      );
    }
    if (!sync.datasetId) {
      throw new TikTokProviderError(
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

      const videos: NormalizedTikTokVideo[] = [];
      for (const raw of items) {
        const normalized = extractVideoFromItem(raw);
        if (normalized.kind === 'video') videos.push(normalized.video);
      }
      // Freshen the confirm card's live stats from the author block that
      // rides every video item.
      if (meta.tiktok?.profile) {
        const card = items.map(extractProfileCardFromItem).find(Boolean);
        if (card) {
          meta.tiktok.profile = {
            ...meta.tiktok.profile,
            displayName: card.displayName ?? meta.tiktok.profile.displayName,
            followers: card.followers ?? meta.tiktok.profile.followers,
            videoCount: card.videoCount ?? meta.tiktok.profile.videoCount,
          };
        }
      }

      await this.upsertVideos(source, videos);
      sync.tiktokVideosEnumerated =
        (sync.tiktokVideosEnumerated ?? 0) + videos.length;
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

    // The treasure map is fresh — plan the harvest and persist it so a
    // resumed job re-enters with the exact same batches.
    const registry = await this.loadRegistry(source);
    const plannable: PlannableVideo[] = registry.map((row) => ({
      videoId: row.video_id,
      url: row.url,
      postedAt: row.posted_at,
      commentCount: row.comment_count,
      baselineCommentCount: row.baseline_comment_count,
      isNew: row.first_seen_at >= sync.startedAt,
    }));
    const batches = planTikTokHarvest(plannable, { refresh });
    sync.tiktokBatches = batches;
    sync.tiktokBatchIndex = 0;
    sync.phase = 'harvest';
    sync.runId = null;
    sync.datasetId = null;
    sync.runStartedAt = null;
    sync.datasetOffset = 0;
    await this.persistSource(source, meta);
    console.log(
      `${opts.label}: enumerated ${sync.tiktokVideosEnumerated ?? 0} videos -> ${batches.reduce((total, batch) => total + batch.videoIds.length, 0)} selected in ${batches.length} batches (refresh=${refresh})`,
    );
  }

  /** Hop 2: sequential batched comment runs off the persisted plan. */
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
    const batches = sync.tiktokBatches ?? [];

    while ((sync.tiktokBatchIndex ?? 0) < batches.length) {
      if (opts.signal.aborted) throw new Error('Brand presence job aborted');
      const batchIndex = sync.tiktokBatchIndex ?? 0;
      const batch = batches[batchIndex];

      if (!sync.runId) {
        const handle = await this.provider.startCommentsRun(
          buildCommentsInput({
            urls: batch.urls,
            commentsPerPost: batch.commentsPerPost,
          }),
        );
        sync.runId = handle.runId;
        sync.datasetId = handle.datasetId;
        sync.runStartedAt = new Date().toISOString();
        sync.datasetOffset = 0;
        sync.tiktokBatchYields = {};
        await this.persistSource(source, meta);
        console.log(
          `${opts.label}: started comments run ${handle.runId} (batch ${batchIndex + 1}/${batches.length}, ${batch.urls.length} videos, cap=${batch.commentsPerPost})`,
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
        // Keep tiktokBatchIndex — committed batches stay committed; the
        // retry re-runs only THIS batch, and its videos' baselines never
        // advanced (the partial-failure guarantee).
        sync.runId = null;
        sync.datasetId = null;
        sync.runStartedAt = null;
        sync.datasetOffset = 0;
        delete sync.tiktokBatchYields;
        await this.persistSource(source, meta);
        throw new TikTokProviderError(
          `TikTok comments run failed (batch ${batchIndex + 1}/${batches.length}${outcome.wedged ? ', wedged' : ''})`,
          { retryable: outcome.retryable },
        );
      }
      if (!sync.datasetId) {
        throw new TikTokProviderError(
          `Run ${sync.runId} succeeded but no datasetId was checkpointed`,
          { retryable: true },
        );
      }

      // The registry join: video id -> url + caption (Hop-2 items carry no
      // caption) + the plan-time comment_count the baseline advances to.
      const videoRows = await this.loadBatchVideos(source, batch.videoIds);
      const lookup = new Map(
        videoRows.map((row) => [
          row.video_id,
          { url: row.url, caption: row.caption },
        ]),
      );
      const batchVideoIds = new Set(batch.videoIds);
      const yields = (sync.tiktokBatchYields ??= {});

      for (;;) {
        if (opts.signal.aborted) throw new Error('Brand presence job aborted');

        const items = await this.provider.listDatasetItems(
          sync.datasetId,
          sync.datasetOffset,
          datasetPageSize,
        );
        if (items.length === 0) break;

        const rawRef = await this.storeRawPage(source, sync, items);

        const mentions: NormalizedTikTokComment[] = [];
        for (const raw of items) {
          // Yield accounting first — ANY item attributable to a batch video
          // (kept, owner-dropped, or short) proves the scrape covered it.
          const attributedId = attributeCommentVideoId(raw);
          if (attributedId && batchVideoIds.has(attributedId)) {
            yields[attributedId] = (yields[attributedId] ?? 0) + 1;
          }

          const normalized = normalizeTikTokCommentItem(raw, {
            ownerUsername: username,
            videoLookup: (videoId) => lookup.get(videoId),
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

      // Batch commit: advance per-video state ONLY for videos that yielded.
      // baseline_comment_count moves to the PLAN-TIME enumerated count (the
      // value this run's delta was computed against). Zero-yield videos are
      // untouched — their delta re-crosses the threshold next refresh.
      // Replays after a crash inside this window are tolerable: the baseline
      // write is idempotent (same plan-time value); comments_ingested is
      // informational and may over-count by one crash window.
      const nowIso = new Date().toISOString();
      let scrapedThisBatch = 0;
      for (const row of videoRows) {
        const yielded = yields[row.video_id] ?? 0;
        if (yielded < 1) continue;
        const { error } = await this._db
          .from('brand_presence_tiktok_videos')
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

      sync.tiktokVideosScraped =
        (sync.tiktokVideosScraped ?? 0) + scrapedThisBatch;
      sync.tiktokBatchIndex = batchIndex + 1;
      sync.runId = null;
      sync.datasetId = null;
      sync.runStartedAt = null;
      sync.datasetOffset = 0;
      delete sync.tiktokBatchYields;
      await this.persistSource(source, meta);
      console.log(
        `${opts.label}: batch ${batchIndex + 1}/${batches.length} committed (${scrapedThisBatch}/${batch.videoIds.length} videos yielded)`,
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
   * baseline_comment_count / comments_ingested (the per-video scrape state
   * a re-enumeration must not touch) while fresh rows seed the baseline at
   * the first-seen count.
   */
  private async upsertVideos(
    source: SourceRow,
    videos: NormalizedTikTokVideo[],
  ): Promise<void> {
    if (videos.length === 0) return;

    // In-page dedupe (defensive — the actor shouldn't repeat videos).
    const byId = new Map<string, NormalizedTikTokVideo>();
    for (const video of videos) {
      if (!byId.has(video.video_id)) byId.set(video.video_id, video);
    }
    const deduped = [...byId.values()];
    const nowIso = new Date().toISOString();

    for (let i = 0; i < deduped.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = deduped.slice(i, i + UPSERT_CHUNK_SIZE);
      const videoIds = chunk.map((video) => video.video_id);

      const { data: existingRows, error: existingError } = await this._db
        .from('brand_presence_tiktok_videos')
        .select('video_id')
        .eq('organization_id', source.organization_id)
        .eq('brand_profile_id', source.brand_profile_id)
        .in('video_id', videoIds);
      if (existingError) throw existingError;
      const existingIds = new Set(
        (existingRows ?? []).map((row) => String(row.video_id)),
      );

      const buildRow = (video: NormalizedTikTokVideo) => ({
        organization_id: source.organization_id,
        brand_profile_id: source.brand_profile_id,
        source_id: source.id,
        video_id: video.video_id,
        url: video.url,
        caption: video.caption,
        posted_at: video.posted_at,
        comment_count: video.comment_count,
        last_enumerated_at: nowIso,
        updated_at: nowIso,
      });

      const fresh = chunk.filter((video) => !existingIds.has(video.video_id));
      const existing = chunk.filter((video) =>
        existingIds.has(video.video_id),
      );

      const upsert = async (rows: Record<string, unknown>[]) => {
        if (rows.length === 0) return;
        const { error } = await this._db
          .from('brand_presence_tiktok_videos')
          .upsert(rows, { onConflict: 'brand_profile_id,video_id' });
        if (error) throw error;
      };

      await upsert(
        fresh.map((video) => ({
          ...buildRow(video),
          // The delta baseline starts at the first-seen count — growth from
          // here is what earns a Hop-2 visit.
          baseline_comment_count: video.comment_count,
        })),
      );
      await upsert(existing.map(buildRow));
    }
  }

  private async upsertMentions(
    source: SourceRow,
    mentions: NormalizedTikTokComment[],
    rawRef: string | null,
  ): Promise<{ written: number; shortText: number }> {
    if (mentions.length === 0) return { written: 0, shortText: 0 };

    // In-batch dedupe by external_id (first wins).
    const byExternalId = new Map<string, NormalizedTikTokComment>();
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
        .eq('platform', 'tiktok')
        .in('external_id', externalIds);
      if (existingError) throw existingError;
      const existingTags = new Map(
        (existingRows ?? []).map((row) => [
          String(row.external_id),
          (row.tags as MentionTags | null) ?? {},
        ]),
      );

      const buildRow = (mention: NormalizedTikTokComment) => ({
        organization_id: source.organization_id,
        brand_profile_id: source.brand_profile_id,
        source_id: source.id,
        platform: 'tiktok',
        external_id: mention.external_id,
        data_type: 'comment',
        scope: 'brand',
        // The mention url points at the VIDEO (comments have no stable own
        // permalink); the caption rides parent_title as extraction context.
        url: mention.url,
        subreddit: null,
        author_ref: mention.author_ref,
        title: null,
        body: mention.body,
        posted_at: mention.posted_at,
        parent_external_id: mention.video_id,
        parent_title: mention.parent_title,
        rating: null,
        raw_ref: rawRef,
        tags: {
          ...existingTags.get(mention.external_id),
          tiktok: {
            videoId: mention.video_id,
            videoUrl: mention.video_url,
            likes: mention.likes,
            replyCount: mention.reply_count,
            isReply: mention.is_reply,
            ...(mention.parent_comment_id
              ? { parentCommentId: mention.parent_comment_id }
              : {}),
          },
        },
      });

      // Partitioned upserts (bulk rows must share one column set); existing
      // rows OMIT relevance/extraction_status entirely so a replay never
      // resets a decided verdict or a skipped/done extraction.
      const existing = chunk.filter((m) => existingTags.has(m.external_id));
      const fresh = chunk.filter((m) => !existingTags.has(m.external_id));
      // "🔥🔥🔥" / "first" comments store for provenance but never reach any
      // LLM — the founder-confirmed own profile means no relevance gate, so
      // the short-text filter is the only spend control.
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
          // relevance LLM (Maps/Trustpilot/Amazon class).
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
    const key = `brand-presence/${source.organization_id}/${source.brand_profile_id}/${source.id}/tiktok-${sync.phase}-${sync.startedAt}-page${sync.page}.json`;
    try {
      await r2Service.uploadFile(
        R2_BUCKET,
        key,
        JSON.stringify(items),
        'application/json',
        { source: 'brand-presence-tiktok' },
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

  /** Commit cursor + last-run stats, clear the checkpoint, mark synced, and
   * hand the new not_required mentions straight to phrase extraction (the
   * relevance gate never touches this source). */
  /** `currentJobId` is load-bearing: when nothing is left to extract this job
   * may be the LAST of the profile's pipeline, so it owns the final
   * theme-rebuild drain check (which must exclude its own processing row). */
  private async finalize(
    source: SourceRow,
    meta: SourceMeta,
    tiktok: TikTokSourceMeta,
    sync: SourceSyncCheckpoint,
    refresh: boolean,
    currentJobId: string,
    label: string,
  ): Promise<void> {
    const zeroItems = sync.counts.upserted === 0 && sync.counts.skipped === 0;
    if (zeroItems) {
      // Expected for small brands (few comment-worthy videos is normal) —
      // recorded in meta.tiktok.lastRun for the panel; the loud log stays as
      // the breakage detector for brands that normally have volume.
      console.warn(`${label}: ZERO comment items returned across all batches`);
    }
    if (sync.maxPostedAt) {
      meta.cursor = { lastPostedAt: sync.maxPostedAt };
    }
    const videosPlanned = (sync.tiktokBatches ?? []).reduce(
      (total, batch) => total + batch.videoIds.length,
      0,
    );
    meta.tiktok = {
      ...tiktok,
      lastRun: {
        finishedAt: new Date().toISOString(),
        refresh,
        videosEnumerated: sync.tiktokVideosEnumerated ?? 0,
        videosPlanned,
        videosScraped: sync.tiktokVideosScraped ?? 0,
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
        ? Math.round((((sync.counts.shortText ?? 0) + sync.counts.skipped) / total) * 100)
        : 0;
    // A 40-60% kill rate is NORMAL for TikTok comments — log, never alert.
    console.log(
      `${label}: synced ${sync.counts.upserted} mentions (${sync.counts.shortText ?? 0} short, ${sync.counts.ownerDropped ?? 0} owner-dropped, ${sync.counts.skipped} skipped; ~${killRate}% filtered — normal for TikTok) across ${sync.tiktokVideosScraped ?? 0}/${videosPlanned} planned videos -> ${extractIds.length} eligible for extraction`,
    );
  }

  private buildScopeKey(username: string, refresh: boolean): string {
    const { tiktok } = BRAND_PRESENCE_CONFIG;
    return createHash('sha256')
      .update(
        JSON.stringify({
          username,
          refresh,
          enumerationMaxVideos: tiktok.enumerationMaxVideos,
          selection: tiktok.selection,
          backfill: tiktok.backfill,
          refreshCfg: tiktok.refresh,
          maxUrlsPerRun: tiktok.maxUrlsPerRun,
        }),
      )
      .digest('hex');
  }

  /** All registry rows for this brand (the planner's input). */
  private async loadRegistry(source: SourceRow): Promise<VideoRow[]> {
    const { data, error } = await this._db
      .from('brand_presence_tiktok_videos')
      .select(
        'id, video_id, url, caption, posted_at, comment_count, baseline_comment_count, comments_ingested, first_seen_at',
      )
      .eq('organization_id', source.organization_id)
      .eq('brand_profile_id', source.brand_profile_id)
      .order('comment_count', { ascending: false })
      .limit(PLAN_LOAD_LIMIT);
    if (error) throw error;
    return (data ?? []) as VideoRow[];
  }

  /** The current batch's registry rows (lookup + plan-time counts). */
  private async loadBatchVideos(
    source: SourceRow,
    videoIds: string[],
  ): Promise<VideoRow[]> {
    const { data, error } = await this._db
      .from('brand_presence_tiktok_videos')
      .select(
        'id, video_id, url, caption, posted_at, comment_count, baseline_comment_count, comments_ingested, first_seen_at',
      )
      .eq('organization_id', source.organization_id)
      .eq('brand_profile_id', source.brand_profile_id)
      .in('video_id', videoIds);
    if (error) throw error;
    return (data ?? []) as VideoRow[];
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

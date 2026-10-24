import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';

/**
 * Pure Hop-2 planning for the TikTok comments adapter (mention-ingest.ts
 * precedent: the budget-critical decisions live in a pure module so they are
 * testable in isolation). The Hop-1 enumeration is the treasure map — these
 * functions decide which videos are worth a (billable) Hop-2 visit and at
 * what per-video comment cap. NEVER send all videos to Hop 2.
 */

/** The planner's slice of BRAND_PRESENCE_CONFIG.tiktok (widened from the
 * as-const literals so tests can exercise custom thresholds). */
export interface TikTokPlanConfig {
  selection: {
    topByComments: number;
    recentCount: number;
    minCommentFloor: number;
  };
  backfill: { commentsPerVideo: number; maxRepliesPerComment: number };
  refresh: { deltaThreshold: number; capMultiplier: number; minCap: number };
  maxUrlsPerRun: number;
}

/** The planner's view of one brand_presence_tiktok_videos row. */
export interface PlannableVideo {
  videoId: string;
  url: string;
  postedAt: string | null;
  /** Latest enumerated commentCount (this Hop-1 pass). */
  commentCount: number;
  /** Delta baseline: count at last successful scrape, or the first-seen
   * count for never-scraped videos. */
  baselineCommentCount: number;
  /** First seen during THIS enumeration (no prior registry row) — new
   * videos follow the backfill selection policy on refresh. */
  isNew: boolean;
}

/** A selected video with its per-video replies-included comment cap. */
export interface PlannedVideo {
  video: PlannableVideo;
  commentsPerPost: number;
}

/** One Hop-2 actor run: ≤ maxUrlsPerRun videos sharing one per-post cap. */
export interface HarvestBatch {
  videoIds: string[];
  urls: string[];
  commentsPerPost: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Deterministic tie-break so equal counts/dates produce a stable plan. */
function byVideoId(a: PlannableVideo, b: PlannableVideo): number {
  return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0;
}

/**
 * Backfill selection: (top-N by commentCount) ∪ (M most recent), MINUS
 * videos under the comment floor. Recency sorts by postedAt — NOT dataset
 * order (excludePinnedPosts=false means pinned old videos lead the dataset).
 * Every selected video gets the flat backfill cap.
 */
export function selectBackfillVideos(
  videos: PlannableVideo[],
  cfg: TikTokPlanConfig = BRAND_PRESENCE_CONFIG.tiktok,
): PlannedVideo[] {
  const eligible = videos.filter(
    (video) => video.commentCount >= cfg.selection.minCommentFloor,
  );

  const top = [...eligible]
    .sort((a, b) => b.commentCount - a.commentCount || byVideoId(a, b))
    .slice(0, cfg.selection.topByComments);

  const recent = [...eligible]
    .sort((a, b) => {
      // Nulls last — an undated video can win on comment count, not recency.
      if (a.postedAt === null && b.postedAt === null) return byVideoId(a, b);
      if (a.postedAt === null) return 1;
      if (b.postedAt === null) return -1;
      return b.postedAt.localeCompare(a.postedAt) || byVideoId(a, b);
    })
    .slice(0, cfg.selection.recentCount);

  const byId = new Map<string, PlannableVideo>();
  for (const video of [...top, ...recent]) {
    byId.set(video.videoId, video);
  }
  return [...byId.values()].map((video) => ({
    video,
    commentsPerPost: cfg.backfill.commentsPerVideo,
  }));
}

/**
 * Diff-driven refresh selection. Known videos re-scrape ONLY when their
 * enumerated count grew ≥ deltaThreshold over the baseline, with a cap of
 * clamp(ceil(delta × capMultiplier), minCap, backfill cap) — the actor can't
 * fetch "only new comments", so the multiplier over-fetches slightly (the
 * idempotent mention upsert absorbs re-seen ones) and covers reply inflation
 * inside the replies-included cap. Videos first seen THIS enumeration follow
 * the backfill selection policy instead (spec rule — a brand-new video has
 * no meaningful delta history).
 */
export function selectRefreshVideos(
  videos: PlannableVideo[],
  cfg: TikTokPlanConfig = BRAND_PRESENCE_CONFIG.tiktok,
): PlannedVideo[] {
  const newVideos = videos.filter((video) => video.isNew);
  const knownVideos = videos.filter((video) => !video.isNew);

  const planned = selectBackfillVideos(newVideos, cfg);
  for (const video of knownVideos) {
    const delta = video.commentCount - video.baselineCommentCount;
    if (delta < cfg.refresh.deltaThreshold) continue;
    planned.push({
      video,
      commentsPerPost: clamp(
        Math.ceil(delta * cfg.refresh.capMultiplier),
        cfg.refresh.minCap,
        cfg.backfill.commentsPerVideo,
      ),
    });
  }
  return planned;
}

/**
 * Groups selected videos into Hop-2 runs. commentsPerPost is a UNIFORM
 * per-run cap, so videos are sorted by cap desc and filled into batches of
 * ≤ maxUrlsPerRun; each batch's cap is its max (= first element). Sorted
 * filling bounds the per-batch over-fetch to near-neighbors; the idempotent
 * upsert absorbs the overshoot.
 */
export function bucketIntoBatches(
  selected: PlannedVideo[],
  cfg: TikTokPlanConfig = BRAND_PRESENCE_CONFIG.tiktok,
): HarvestBatch[] {
  const sorted = [...selected].sort(
    (a, b) =>
      b.commentsPerPost - a.commentsPerPost || byVideoId(a.video, b.video),
  );
  const batches: HarvestBatch[] = [];
  for (let i = 0; i < sorted.length; i += cfg.maxUrlsPerRun) {
    const chunk = sorted.slice(i, i + cfg.maxUrlsPerRun);
    batches.push({
      videoIds: chunk.map((entry) => entry.video.videoId),
      urls: chunk.map((entry) => entry.video.url),
      commentsPerPost: chunk[0].commentsPerPost,
    });
  }
  return batches;
}

/** The full plan: selection policy (backfill or delta refresh) -> batches. */
export function planTikTokHarvest(
  videos: PlannableVideo[],
  opts: { refresh: boolean },
  cfg: TikTokPlanConfig = BRAND_PRESENCE_CONFIG.tiktok,
): HarvestBatch[] {
  const selected = opts.refresh
    ? selectRefreshVideos(videos, cfg)
    : selectBackfillVideos(videos, cfg);
  return bucketIntoBatches(selected, cfg);
}

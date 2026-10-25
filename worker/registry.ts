import type { SupabaseClient } from '@supabase/supabase-js';
import type { FunctionTimeoutTracker } from '@/services/job-processor/function-timeout';
import type { Job } from '@/services/job-processor/types';
import { AdLibrarySyncProcessor } from '@/services/job-processor/ad-library/sync-processor';
import { AdLibraryLabelBatchProcessor } from '@/services/job-processor/ad-library/label-processor';
import { AdLibraryEmbedBatchProcessor } from '@/services/job-processor/ad-library/embed-processor';
import { ADLIB_MEDIA_REHOST_JOB_TYPE } from '@/services/job-processor/ad-library/types';
import { BrandPresenceDiscoverProcessor } from '@/services/job-processor/brand-presence/discover-processor';
import { BrandPresenceSubredditDiscoveryProcessor } from '@/services/job-processor/brand-presence/subreddit-discovery-processor';
import { BrandPresenceRedditScrapeProcessor } from '@/services/job-processor/brand-presence/reddit-scrape-processor';
import { BrandPresenceRelevanceProcessor } from '@/services/job-processor/brand-presence/relevance-processor';
import { BrandPresenceGooglePlaceProcessor } from '@/services/job-processor/brand-presence/google-place-processor';
import { BrandPresenceGoogleReviewsProcessor } from '@/services/job-processor/brand-presence/google-reviews-processor';
import { BrandPresenceXScrapeProcessor } from '@/services/job-processor/brand-presence/x-scrape-processor';
import { BrandPresenceTrustpilotResolveProcessor } from '@/services/job-processor/brand-presence/trustpilot-resolve-processor';
import { BrandPresenceTrustpilotReviewsProcessor } from '@/services/job-processor/brand-presence/trustpilot-reviews-processor';
import { BrandPresenceTikTokProfileProcessor } from '@/services/job-processor/brand-presence/tiktok-profile-processor';
import { BrandPresenceTikTokCommentsProcessor } from '@/services/job-processor/brand-presence/tiktok-comments-processor';
import { BrandPresenceInstagramProfileProcessor } from '@/services/job-processor/brand-presence/instagram-profile-processor';
import { BrandPresenceInstagramCommentsProcessor } from '@/services/job-processor/brand-presence/instagram-comments-processor';
import { BrandPresenceExtractProcessor } from '@/services/job-processor/brand-presence/extract-processor';
import { BrandPresenceClusterProcessor } from '@/services/job-processor/brand-presence/cluster-processor';
import { BrandObjectPromoteProcessor } from '@/services/job-processor/brand-object/promote-processor';
import { BrandObjectChunksProcessor } from '@/services/job-processor/brand-object/chunks-processor';
import { BrandObjectCrawlProcessor } from '@/services/job-processor/brand-object/crawl-processor';
import { BrandObjectIdentityProcessor } from '@/services/job-processor/brand-object/identity-processor';
import { BrandObjectMarketProcessor } from '@/services/job-processor/brand-object/market-processor';
import { BrandObjectPersonasProcessor } from '@/services/job-processor/brand-object/personas-processor';

export interface JobProcessor {
  process(
    _job: Job,
    _signal: AbortSignal,
    _timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void>;
}

/**
 * Adcero's PROCESSOR_REGISTRY (services/job-processor/job-executor.ts L121–165),
 * limited to the processors Ad Lab copies: ad-library sync → label → embed,
 * brand-presence listening (no Amazon) and the six brand-object distillation
 * steps. A fresh processor per job: processors hold per-job state.
 */
export const PROCESSOR_REGISTRY: Record<string, (_db: SupabaseClient) => JobProcessor> = {
  adlib_sync_competitor: (db) => new AdLibrarySyncProcessor(db),
  adlib_label_batch: (db) => new AdLibraryLabelBatchProcessor(db),
  adlib_embed_batch: (db) => new AdLibraryEmbedBatchProcessor(db),
  brand_presence_discover: (db) => new BrandPresenceDiscoverProcessor(db),
  brand_presence_reddit_subreddits: (db) => new BrandPresenceSubredditDiscoveryProcessor(db),
  brand_presence_reddit_scrape: (db) => new BrandPresenceRedditScrapeProcessor(db),
  brand_presence_relevance: (db) => new BrandPresenceRelevanceProcessor(db),
  // Adcero's drain-out alias: brand_presence_insights rows execute as extract.
  brand_presence_insights: (db) => new BrandPresenceExtractProcessor(db),
  brand_presence_extract: (db) => new BrandPresenceExtractProcessor(db),
  brand_presence_cluster: (db) => new BrandPresenceClusterProcessor(db),
  brand_presence_google_place: (db) => new BrandPresenceGooglePlaceProcessor(db),
  brand_presence_google_reviews: (db) => new BrandPresenceGoogleReviewsProcessor(db),
  brand_presence_x_scrape: (db) => new BrandPresenceXScrapeProcessor(db),
  brand_presence_trustpilot_resolve: (db) => new BrandPresenceTrustpilotResolveProcessor(db),
  brand_presence_trustpilot_reviews: (db) => new BrandPresenceTrustpilotReviewsProcessor(db),
  brand_presence_tiktok_profile: (db) => new BrandPresenceTikTokProfileProcessor(db),
  brand_presence_tiktok_comments: (db) => new BrandPresenceTikTokCommentsProcessor(db),
  brand_presence_instagram_profile: (db) => new BrandPresenceInstagramProfileProcessor(db),
  brand_presence_instagram_comments: (db) => new BrandPresenceInstagramCommentsProcessor(db),
  brand_object_promote: (db) => new BrandObjectPromoteProcessor(db),
  brand_object_chunks: (db) => new BrandObjectChunksProcessor(db),
  brand_object_crawl: (db) => new BrandObjectCrawlProcessor(db),
  brand_object_identity: (db) => new BrandObjectIdentityProcessor(db),
  brand_object_market: (db) => new BrandObjectMarketProcessor(db),
  brand_object_personas: (db) => new BrandObjectPersonasProcessor(db),
};

/**
 * Job types Ad Lab enqueues but never runs: the worker marks them cancelled
 * with result.skipped, never failed. Every competitor sync enqueues media
 * rehost batches; the rehost processor is R2-only and wasn't ported.
 */
export const SKIPPED_JOB_TYPES: Record<string, string> = {
  [ADLIB_MEDIA_REHOST_JOB_TYPE]: 'media rehost not ported (A1); ads keep their expiring Meta CDN links',
};

/** The env that freezes the shared brand object (set by `npm run worker:live`). */
export const FREEZE_BRAND_OBJECT_ENV = 'ADLAB_FREEZE_BRAND_OBJECT';

export const FROZEN_BRAND_OBJECT_REASON =
  'brand object frozen (ADLAB_FREEZE_BRAND_OBJECT=1): a refresh must not rewrite the persona facts the live run reads';

export const isBrandObjectFrozen = (env: NodeJS.ProcessEnv = process.env): boolean => env[FREEZE_BRAND_OBJECT_ENV]?.trim() === '1';

/**
 * Why the worker skips this job type, or undefined to run it. With ADLAB_FREEZE_BRAND_OBJECT=1
 * every brand_object_* job is skipped like SKIPPED_JOB_TYPES (cancelled, never failed or left
 * pending): a Meta sync chains market -> personas, which rewrites the shared persona facts that
 * A5 reads for B's live demo run.
 */
export function skipReasonFor(type: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return SKIPPED_JOB_TYPES[type] ?? (type.startsWith('brand_object_') && isBrandObjectFrozen(env) ? FROZEN_BRAND_OBJECT_REASON : undefined);
}

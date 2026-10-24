import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { r2Service } from '@/services/r2-service';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type {
  BrandPresenceSource,
  MentionRelevance,
  MentionScope,
  ProfileMeta,
  ScrapeMode,
  SourceMeta,
  SourceSyncCheckpoint,
} from '@/lib/brand-presence/types';
import {
  buildBrandSearchInput,
  buildBrandThreadsInput,
  buildCompetitorSearchInput,
  buildSubredditFeedInput,
  buildSubredditSearchInput,
  normalizeSubredditName,
  type RedditScraperLiteInput,
} from '@/services/brand-presence/reddit-actor-input';
import {
  RedditApifyProvider,
  RedditProviderError,
} from '@/services/brand-presence/reddit-apify-provider';
import {
  containsNameVariant,
  normalizeRedditItem,
  type NormalizedRedditMention,
} from '@/services/brand-presence/reddit-normalizer';
import {
  applyPrunedTerms,
  resolvePrunedTerms,
} from '@/services/brand-presence/reddit-term-stats';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import {
  contentScope,
  decideMention,
  mergeRelevance,
  mergeScope,
  requiredTermsForPhase,
  scopeRank,
} from './mention-ingest';
import {
  enqueueExtractOrDrainCluster,
  enqueueRelevanceBatches,
} from './queue';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceScrapePayloadSchema } from './types';

const R2_BUCKET = 'adcero-ad-creatives';
const UPSERT_CHUNK_SIZE = 100;
const IN_FILTER_CHUNK_SIZE = 100;

const MODE_BY_SOURCE_TYPE: Record<string, ScrapeMode> = {
  reddit_search: 'brand_search',
  reddit_subreddit: 'subreddit',
  // Kept as the DB source_type value; the mode now listens for competitor
  // names only (see reddit-actor-input.ts buildCompetitorSearchInput).
  reddit_category: 'competitor_search',
};

interface ProfileRow {
  id: string;
  brand_name: string;
  name_variants: string[];
  category: string | null;
  competitors: string[];
  meta: ProfileMeta | null;
}

/**
 * A run phase: Run C is 'single'; Run A advances 'search' -> 'threads'; Run B
 * advances 'search' -> 'feed' on a first sync while `subredditFeed.enabled`
 * (a refresh run stops after 'search').
 */
type ScrapePhase = SourceSyncCheckpoint['phase'];

/**
 * brand_presence_reddit_scrape — drives one source row through its actor
 * run(s), archives raw dataset pages to R2, and merge-upserts normalized
 * mentions (idempotent on (brand_profile_id, platform, external_id)).
 *
 * Crash-resume: every step persists a checkpoint into source.meta.sync
 * (runId/datasetId immediately after start, datasetOffset per ingested page,
 * phase on advance), so a killed worker or a FunctionTimeoutError yield
 * resumes the SAME run / the same dataset offset — never a second billable
 * run, never duplicate mentions.
 */
export class BrandPresenceRedditScrapeProcessor {
  private providerInstance: RedditApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: RedditApifyProvider,
  ) {
    // Injectable for tests; lazy by default so constructing the processor
    // (e.g. the registry test) does not require APIFY_TOKEN.
    this.providerInstance = provider ?? null;
  }

  private get provider(): RedditApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new RedditApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceScrapePayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, sourceId, refresh } = payload;
    const label = `[BrandPresence] Source ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source) {
      console.log(`${label}: not found for org ${organizationId}, skipping`);
      return;
    }
    const mode = MODE_BY_SOURCE_TYPE[source.source_type];
    if (!mode) {
      console.log(
        `${label}: source_type ${source.source_type} is not scrapeable, skipping`,
      );
      return;
    }
    const profile = await this.loadProfile(organizationId, brandProfileId);
    if (!profile) {
      console.log(`${label}: profile ${brandProfileId} missing, skipping`);
      return;
    }
    if (mode === 'brand_search' && profile.name_variants.length === 0) {
      console.log(`${label}: no name variants to search, skipping`);
      return;
    }

    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const refreshCursor = refresh ? meta.cursor?.lastPostedAt : undefined;
    const scopeKey = this.buildScopeKey(source, profile, refresh);

    // Resume a matching in-flight checkpoint; a scopeKey mismatch means the
    // source/profile config changed between attempts — discard it.
    let sync: SourceSyncCheckpoint;
    if (meta.sync && meta.sync.scopeKey === scopeKey) {
      sync = meta.sync;
      console.log(
        `${label}: resuming (phase=${sync.phase}, runId=${sync.runId ?? 'none'}, offset=${sync.datasetOffset})`,
      );
    } else {
      sync = {
        scopeKey,
        startedAt: new Date().toISOString(),
        // Run C is single-run; Runs A and B both start with a search phase.
        phase: mode === 'competitor_search' ? 'single' : 'search',
        runId: null,
        datasetId: null,
        runStartedAt: null,
        datasetOffset: 0,
        // Run A multi-sort backfill starts at the first sort pass.
        searchSortIndex: mode === 'brand_search' ? 0 : undefined,
        // Homonym terms dropped for this whole sync (fixed for resumes).
        prunedTerms: resolvePrunedTerms(profile),
        page: 0,
        maxPostedAt: meta.cursor?.lastPostedAt ?? null,
        counts: { upserted: 0, skipped: 0 },
      };
    }
    meta.sync = sync;
    await this.persistMeta(source, meta, { status: 'running' });
    const prunedCount =
      (sync.prunedTerms?.variants.length ?? 0) +
      (sync.prunedTerms?.competitors.length ?? 0);
    if (prunedCount > 0) {
      console.log(
        `${label}: dropping homonym terms from Reddit search: ${[...(sync.prunedTerms?.variants ?? []), ...(sync.prunedTerms?.competitors ?? [])].join(', ')}`,
      );
    }

    try {
      for (;;) {
        if (signal.aborted) throw new Error('Brand presence job aborted');

        // Start this phase's run if none is checkpointed. Persist the ids in
        // the very next await — that window is the only unavoidable orphan.
        if (!sync.runId) {
          const input = await this.buildPhaseInput(
            mode,
            sync.phase,
            source,
            applyPrunedTerms(profile, sync.prunedTerms),
            refreshCursor,
            sync.searchSortIndex ?? 0,
          );
          // Every search term of this phase was pruned: nothing to bill.
          if (input.searches && input.searches.length === 0) {
            console.log(
              `${label}: every search term is pruned (phase=${sync.phase}), skipping the run`,
            );
            break;
          }
          const handle = await this.provider.startRun(input);
          sync.runId = handle.runId;
          sync.datasetId = handle.datasetId;
          sync.runStartedAt = new Date().toISOString();
          sync.datasetOffset = 0;
          await this.persistMeta(source, meta);
          console.log(
            `${label}: started run ${handle.runId} (phase=${sync.phase})`,
          );
        }

        const outcome = await awaitRunCompletion({
          provider: this.provider,
          runId: sync.runId,
          runStartedAt: sync.runStartedAt ?? sync.startedAt,
          signal,
          timeoutTracker,
          label,
        });
        if (outcome.outcome === 'failed') {
          // Clear the dead run so a job retry starts a fresh one (the wedged
          // path already aborted it).
          sync.runId = null;
          sync.datasetId = null;
          sync.runStartedAt = null;
          await this.persistMeta(source, meta);
          throw new RedditProviderError(
            `Reddit scraper run failed (phase=${sync.phase}${outcome.wedged ? ', wedged' : ''})`,
            { retryable: outcome.retryable },
          );
        }

        await this.ingestDataset(source, profile, mode, sync, meta, {
          signal,
          timeoutTracker,
          label,
        });

        // Run B: on a first sync the community-search phase is followed by the
        // feed crawl (while `subredditFeed.enabled`). Refresh runs stop after
        // the search phase: its
        // cursor-bounded 'new' sort already returns what a top-of-year feed
        // would re-fetch, and each extra run pays the actor start fee.
        if (
          mode === 'subreddit' &&
          sync.phase === 'search' &&
          !refresh &&
          BRAND_PRESENCE_CONFIG.subredditFeed.enabled
        ) {
          sync.phase = 'feed';
          this.resetRunForNextPhase(sync);
          await this.persistMeta(source, meta);
          if (timeoutTracker?.shouldStop()) {
            throw new FunctionTimeoutError(
              'Function timeout - will resume on next cron',
            );
          }
          continue;
        }

        // Run A: the primary relevance-sort pass is normally enough. Only pay
        // for the top-sort fallback when containment left too little signal.
        // Refresh runs stay single-pass (cursor-based).
        if (mode === 'brand_search' && sync.phase === 'search' && !refresh) {
          const sortCount = BRAND_PRESENCE_CONFIG.brandSearchSorts.length;
          const nextSort = (sync.searchSortIndex ?? 0) + 1;
          const primaryPassHadEnoughSignal =
            (sync.searchSortIndex ?? 0) === 0 &&
            sync.counts.upserted >=
              BRAND_PRESENCE_CONFIG.brandSearch.fallbackMinKeptItems;
          if (!primaryPassHadEnoughSignal && nextSort < sortCount) {
            sync.searchSortIndex = nextSort;
            this.resetRunForNextPhase(sync);
            await this.persistMeta(source, meta);
            if (timeoutTracker?.shouldStop()) {
              throw new FunctionTimeoutError(
                'Function timeout - will resume on next cron',
              );
            }
            continue;
          }
        }

        // Run A: after the brand search, fetch full comment trees for the
        // stored brand posts so every reply shows Reddit-style. Skipped on
        // refresh runs, when the brand name is flagged generic, or when no
        // brand posts were captured.
        if (mode === 'brand_search' && sync.phase === 'search') {
          const runThreads =
            !refresh &&
            !meta.flags?.genericBrandName &&
            (await this.hasBrandPostsWithComments(source, profile));
          if (runThreads) {
            sync.phase = 'threads';
            this.resetRunForNextPhase(sync);
            await this.persistMeta(source, meta);
            if (timeoutTracker?.shouldStop()) {
              throw new FunctionTimeoutError(
                'Function timeout - will resume on next cron',
              );
            }
            continue;
          }
        }
        break;
      }

      await this.finalize(source, meta, sync, String(job.id), label);
    } catch (error) {
      // Leave the checkpoint intact for timeouts (the whole point of resume);
      // for real failures record the error and surface status=error.
      if (!(error instanceof FunctionTimeoutError)) {
        meta.lastError = {
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        };
        await this.persistMeta(source, meta, { status: 'error' }).catch(
          () => {},
        );
      }
      throw error;
    }
  }

  private async loadSource(
    organizationId: string,
    brandProfileId: string,
    sourceId: string,
  ): Promise<BrandPresenceSource | null> {
    const { data, error } = await this._db
      .from('brand_presence_sources')
      .select('*')
      .eq('id', sourceId)
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .maybeSingle();
    if (error) throw error;
    return (data as BrandPresenceSource | null) ?? null;
  }

  private async loadProfile(
    organizationId: string,
    brandProfileId: string,
  ): Promise<ProfileRow | null> {
    const { data, error } = await this._db
      .from('brand_presence_profiles')
      .select('id, brand_name, name_variants, category, competitors, meta')
      .eq('id', brandProfileId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: String(data.id),
      brand_name: String(data.brand_name),
      name_variants: asStringArray(data.name_variants),
      category: (data.category as string | null) ?? null,
      competitors: asStringArray(data.competitors),
      meta: (data.meta as ProfileMeta | null) ?? null,
    };
  }

  /** Config fingerprint — a changed input discards a stale checkpoint. */
  private buildScopeKey(
    source: BrandPresenceSource,
    profile: ProfileRow,
    refresh: boolean,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          sourceType: source.source_type,
          uri: source.uri,
          refresh,
          nameVariants: profile.name_variants,
          competitors: profile.competitors,
          category: profile.category,
          discoveryBudgetVersion: 2,
        }),
      )
      .digest('hex');
  }

  private resetRunForNextPhase(sync: SourceSyncCheckpoint): void {
    sync.runId = null;
    sync.datasetId = null;
    sync.runStartedAt = null;
    sync.datasetOffset = 0;
  }

  /** `profile` is the search-side profile (`applyPrunedTerms`). */
  private async buildPhaseInput(
    mode: ScrapeMode,
    phase: ScrapePhase,
    source: BrandPresenceSource,
    profile: Omit<ProfileRow, 'brand_name'> & { brand_name: string | null },
    refreshCursor: string | undefined,
    searchSortIndex: number,
  ): Promise<RedditScraperLiteInput> {
    const refreshOpts = refreshCursor ? { refreshCursor } : undefined;
    if (mode === 'brand_search') {
      if (phase === 'threads') {
        const urls = await this.loadBrandPostUrls(source, profile);
        return buildBrandThreadsInput(urls);
      }
      // Multi-sort recall: each backfill pass uses the next sort order.
      const sorts = BRAND_PRESENCE_CONFIG.brandSearchSorts;
      const sort = sorts[Math.min(searchSortIndex, sorts.length - 1)];
      return buildBrandSearchInput(profile.name_variants, refreshOpts, sort);
    }
    if (mode === 'competitor_search') {
      return buildCompetitorSearchInput(profile.competitors, refreshOpts);
    }
    // subreddit mode: 'search' then 'feed' (first sync only; refresh stops
    // after 'search').
    const subreddit = normalizeSubredditName(source.uri || source.label || '');
    if (!subreddit) {
      throw new RedditProviderError(
        `Subreddit source ${source.id} has no usable subreddit name`,
        { retryable: false },
      );
    }
    return phase === 'search'
      ? buildSubredditSearchInput(
          subreddit,
          profile.brand_name,
          profile.competitors,
          refreshOpts,
        )
      : buildSubredditFeedInput(subreddit);
  }

  /**
   * Whether any brand-scope post (profile-wide, incl. posts promoted by Runs
   * B/C) is worth fetching a comment tree for — a cheap existence probe that
   * gates the threads phase.
   */
  private async hasBrandPostsWithComments(
    source: BrandPresenceSource,
    profile: ProfileRow,
  ): Promise<boolean> {
    const { data, error } = await this._db
      .from('brand_mentions')
      .select('id')
      .eq('organization_id', source.organization_id)
      .eq('brand_profile_id', profile.id)
      .eq('platform', 'reddit')
      .eq('data_type', 'post')
      .eq('scope', 'brand')
      .not('url', 'is', null)
      .neq('relevance', 'irrelevant')
      .limit(1);
    if (error) throw error;
    return (data ?? []).length > 0;
  }

  /**
   * Permalinks of the newest brand-scope posts (profile-wide) whose thread we
   * fetch in the threads phase. Excludes posts already judged irrelevant (no
   * point pulling a homonym thread). Capped at brandThreads.maxPosts.
   */
  private async loadBrandPostUrls(
    source: BrandPresenceSource,
    profile: Pick<ProfileRow, 'id'>,
  ): Promise<string[]> {
    const { data, error } = await this._db
      .from('brand_mentions')
      .select('url')
      .eq('organization_id', source.organization_id)
      .eq('brand_profile_id', profile.id)
      .eq('platform', 'reddit')
      .eq('data_type', 'post')
      .eq('scope', 'brand')
      .not('url', 'is', null)
      .neq('relevance', 'irrelevant')
      .order('posted_at', { ascending: false, nullsFirst: false })
      .limit(BRAND_PRESENCE_CONFIG.brandThreads.maxPosts);
    if (error) throw error;
    return (data ?? [])
      .map((row) => (row.url as string | null) ?? '')
      .filter((url) => url.trim() !== '');
  }

  /**
   * Relevance of stored brand-scope POSTS by external_id — drives thread-child
   * inheritance at ingest (parent decided irrelevant -> child irrelevant).
   */
  private async loadBrandPostRelevance(
    source: BrandPresenceSource,
    profileId: string,
    externalIds: string[],
  ): Promise<Map<string, MentionRelevance>> {
    const result = new Map<string, MentionRelevance>();
    if (externalIds.length === 0) return result;
    for (let i = 0; i < externalIds.length; i += IN_FILTER_CHUNK_SIZE) {
      const chunk = externalIds.slice(i, i + IN_FILTER_CHUNK_SIZE);
      const { data, error } = await this._db
        .from('brand_mentions')
        .select('external_id, relevance')
        .eq('organization_id', source.organization_id)
        .eq('brand_profile_id', profileId)
        .eq('platform', 'reddit')
        .eq('data_type', 'post')
        .eq('scope', 'brand')
        .in('external_id', chunk);
      if (error) throw error;
      for (const row of data ?? []) {
        result.set(String(row.external_id), row.relevance as MentionRelevance);
      }
    }
    return result;
  }

  /**
   * Pages the finished run's dataset from the checkpointed offset: archive
   * raw page -> normalize -> assign scope/relevance -> merge-upsert ->
   * persist the new offset. Replayed pages after a crash are harmless (the
   * upsert key absorbs them).
   */
  private async ingestDataset(
    source: BrandPresenceSource,
    profile: ProfileRow,
    mode: ScrapeMode,
    sync: SourceSyncCheckpoint,
    meta: SourceMeta,
    opts: {
      signal: AbortSignal;
      timeoutTracker?: FunctionTimeoutTracker;
      label: string;
    },
  ): Promise<void> {
    const { datasetPageSize } = BRAND_PRESENCE_CONFIG;
    if (!sync.datasetId) {
      throw new RedditProviderError(
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

      const rawRef = await this.storeRawPage(source, sync, items);
      const mentions = await this.classifyPage(
        source,
        profile,
        mode,
        sync,
        items,
      );

      const upserted = await this.mergeUpsertMentions(source, mentions, rawRef);
      sync.counts.upserted += upserted;
      sync.datasetOffset += items.length;
      sync.page += 1;
      await this.persistMeta(source, meta);

      if (items.length < datasetPageSize) break;
      if (opts.timeoutTracker?.shouldStop()) {
        throw new FunctionTimeoutError(
          'Function timeout - will resume on next cron',
        );
      }
    }
  }

  /**
   * Two-pass classification of one dataset page:
   *
   * 1. Normalize every item and derive its CONTENT scope (brand > competitor >
   *    category; comments by body only). Reddit search is fuzzy — items whose
   *    RAW text (title+body, incl. a comment's synthetic "/u/X on <title>")
   *    doesn't name a required term are dropped BEFORE storage (never judged,
   *    never shown) UNLESS they are a reply under a brand post.
   * 2. Thread-keeping: a comment whose parent is a stored/just-seen brand post
   *    is kept regardless of the gate and shown Reddit-style. It inherits the
   *    parent's decided-irrelevant verdict, else stays not_required (kept but
   *    unbilled). Its content scope survives so a reply naming a competitor
   *    still feeds competitor insights.
   */
  private async classifyPage(
    source: BrandPresenceSource,
    profile: ProfileRow,
    mode: ScrapeMode,
    sync: SourceSyncCheckpoint,
    items: unknown[],
  ): Promise<
    Array<{
      mention: NormalizedRedditMention;
      scope: MentionScope;
      relevance: MentionRelevance;
    }>
  > {
    sync.counts.filtered ??= 0;
    // The gate looks for exactly what this sync searched for (pruned homonyms
    // removed); content scope below still reads the full profile.
    const requiredTerms = requiredTermsForPhase(
      mode,
      sync.phase,
      applyPrunedTerms(profile, sync.prunedTerms),
    );

    // Pass 1: normalize + content scope.
    const classified: Array<{
      normalized: Extract<
        ReturnType<typeof normalizeRedditItem>,
        { kind: 'mention' }
      >;
      scope: MentionScope;
    }> = [];
    const pageBrandPostIds = new Set<string>();
    const commentParentIds = new Set<string>();
    for (const item of items) {
      const normalized = normalizeRedditItem(item);
      if (normalized.kind !== 'mention') {
        sync.counts.skipped++;
        continue;
      }
      const scope = contentScope(normalized.mention, profile);
      classified.push({ normalized, scope });
      if (normalized.mention.data_type === 'post' && scope === 'brand') {
        pageBrandPostIds.add(normalized.mention.external_id);
      }
      const parentId = normalized.mention.parent_external_id;
      if (normalized.mention.data_type === 'comment' && parentId) {
        commentParentIds.add(parentId);
      }
    }

    // Brand-post relevance for thread-child inheritance: stored posts win
    // (they may already be decided), brand posts newly seen on this page are
    // treated as pending.
    const brandPostRelevance = await this.loadBrandPostRelevance(
      source,
      profile.id,
      [...commentParentIds],
    );
    for (const id of pageBrandPostIds) {
      if (!brandPostRelevance.has(id)) brandPostRelevance.set(id, 'pending');
    }

    // Pass 2: gate + thread-keeping decision.
    const kept: Array<{
      mention: NormalizedRedditMention;
      scope: MentionScope;
      relevance: MentionRelevance;
    }> = [];
    for (const { normalized, scope } of classified) {
      const { mention } = normalized;
      const parentId = mention.parent_external_id;
      const isThreadChild =
        mention.data_type === 'comment' &&
        !!parentId &&
        brandPostRelevance.has(parentId);
      const decision = decideMention({
        scope,
        gatePassed:
          requiredTerms === null ||
          containsNameVariant(normalized.rawText, requiredTerms),
        isThreadChild,
        parentIrrelevant:
          !!parentId && brandPostRelevance.get(parentId) === 'irrelevant',
      });
      if (!decision.keep) {
        sync.counts.filtered++;
        continue;
      }
      kept.push({
        mention,
        scope: decision.scope,
        relevance: decision.relevance,
      });
      const postedAt = mention.posted_at;
      if (postedAt && (!sync.maxPostedAt || postedAt > sync.maxPostedAt)) {
        sync.maxPostedAt = postedAt;
      }
    }
    return kept;
  }

  /**
   * Merge-upsert: the same Reddit item can arrive from several runs/phases.
   * Higher-rank scope wins (brand > competitor > category); a not_required
   * item promoted to a judged scope flips to pending; a decided
   * relevant/irrelevant verdict is NEVER reset; source_id and parent fields
   * keep the first non-null writer. Returns the number of rows written.
   */
  private async mergeUpsertMentions(
    source: BrandPresenceSource,
    incoming: Array<{
      mention: NormalizedRedditMention;
      scope: MentionScope;
      relevance: MentionRelevance;
    }>,
    rawRef: string | null,
  ): Promise<number> {
    if (incoming.length === 0) return 0;

    // Dedupe within the batch (a search can return the same item twice; a
    // duplicate in one upsert aborts with "cannot affect row a second time").
    // The highest-rank scope entry wins the slot.
    const byExternalId = new Map<string, (typeof incoming)[number]>();
    for (const entry of incoming) {
      const existing = byExternalId.get(entry.mention.external_id);
      if (!existing || scopeRank(entry.scope) > scopeRank(existing.scope)) {
        byExternalId.set(entry.mention.external_id, entry);
      }
    }
    const deduped = [...byExternalId.values()];

    let written = 0;
    for (let i = 0; i < deduped.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = deduped.slice(i, i + UPSERT_CHUNK_SIZE);
      const externalIds = chunk.map((entry) => entry.mention.external_id);

      const { data: existingRows, error: existingError } = await this._db
        .from('brand_mentions')
        .select(
          'external_id, scope, relevance, source_id, parent_external_id, parent_title',
        )
        .eq('organization_id', source.organization_id)
        .eq('brand_profile_id', source.brand_profile_id)
        .eq('platform', 'reddit')
        .in('external_id', externalIds);
      if (existingError) throw existingError;
      const existingByExternalId = new Map(
        (existingRows ?? []).map((row) => [String(row.external_id), row]),
      );

      const rows = chunk.map((entry) => {
        const existing = existingByExternalId.get(entry.mention.external_id);
        const mergedScope = mergeScope(
          existing?.scope as MentionScope | undefined,
          entry.scope,
        );
        // Relevance of the incoming entry against the merged (possibly
        // promoted) scope: a category->brand/competitor promotion should be
        // judged, so the incoming pending survives the merge.
        const incomingRelevance: MentionRelevance =
          mergedScope !== 'category' && entry.relevance === 'not_required'
            ? 'pending'
            : entry.relevance;
        const mergedRelevance = mergeRelevance(
          existing?.relevance as MentionRelevance | undefined,
          incomingRelevance,
        );
        return {
          organization_id: source.organization_id,
          brand_profile_id: source.brand_profile_id,
          source_id: existing?.source_id ?? source.id,
          platform: 'reddit',
          external_id: entry.mention.external_id,
          data_type: entry.mention.data_type,
          scope: mergedScope,
          url: entry.mention.url,
          subreddit: entry.mention.subreddit,
          author_ref: entry.mention.author_ref,
          title: entry.mention.title,
          body: entry.mention.body,
          parent_external_id:
            entry.mention.parent_external_id ??
            (existing?.parent_external_id as string | null) ??
            null,
          parent_title:
            entry.mention.parent_title ??
            (existing?.parent_title as string | null) ??
            null,
          posted_at: entry.mention.posted_at,
          relevance: mergedRelevance,
          raw_ref: rawRef,
          // relevance_confidence intentionally omitted — set only by the
          // relevance processor; created_at defaults on insert.
        };
      });

      const { error: upsertError } = await this._db
        .from('brand_mentions')
        .upsert(rows, { onConflict: 'brand_profile_id,platform,external_id' });
      if (upsertError) throw upsertError;
      written += rows.length;
    }
    return written;
  }

  /** Best-effort raw page archive (mirrors the Layer-1 key convention). */
  private async storeRawPage(
    source: BrandPresenceSource,
    sync: SourceSyncCheckpoint,
    items: unknown[],
  ): Promise<string | null> {
    const key = `brand-presence/${source.organization_id}/${source.brand_profile_id}/${source.id}/${sync.startedAt}-page${sync.page}.json`;
    try {
      await r2Service.uploadFile(
        R2_BUCKET,
        key,
        JSON.stringify(items),
        'application/json',
        { source: 'brand-presence-scrape' },
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

  /** Commit cursor + status, clear the checkpoint, hand off to relevance. */
  private async finalize(
    source: BrandPresenceSource,
    meta: SourceMeta,
    sync: SourceSyncCheckpoint,
    currentJobId: string,
    label: string,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    if (sync.maxPostedAt) {
      meta.cursor = { lastPostedAt: sync.maxPostedAt };
    }
    delete meta.sync;
    delete meta.lastError;
    await this.persistMeta(source, meta, {
      status: 'synced',
      last_synced_at: nowIso,
    });

    // Queue the relevance gate over every still-pending mention of this
    // brand (not just this source's writes — Run B/C promotions may carry
    // another source_id). Batch dedupe keys absorb overlap between scrapes.
    const { data: pending, error: pendingError } = await this._db
      .from('brand_mentions')
      .select('id')
      .eq('organization_id', source.organization_id)
      .eq('brand_profile_id', source.brand_profile_id)
      .eq('relevance', 'pending')
      .limit(2000);
    if (pendingError) throw pendingError;
    const mentionIds = (pending ?? []).map((row) => String(row.id));
    if (mentionIds.length > 0) {
      const { jobIds, deduped } = await enqueueRelevanceBatches(this._db, {
        organizationId: source.organization_id,
        brandProfileId: source.brand_profile_id,
        mentionIds,
      });
      console.log(
        `${label}: synced ${sync.counts.upserted} mentions (${sync.counts.filtered ?? 0} filtered as non-containing, ${sync.counts.skipped} skipped) -> ${jobIds.length} relevance batches (${deduped} deduped)`,
      );
    } else {
      // No pending mentions to judge (e.g. a Run B feed-only sync produced
      // only not_required items) — the relevance drain-finalize hook will
      // never fire, so enqueue phrase extraction directly.
      const { extractIds } = await enqueueExtractOrDrainCluster(this._db, {
        organizationId: source.organization_id,
        brandProfileId: source.brand_profile_id,
        excludeJobId: currentJobId,
      });
      console.log(
        `${label}: synced ${sync.counts.upserted} mentions (${sync.counts.filtered ?? 0} filtered as non-containing, ${sync.counts.skipped} skipped), none pending relevance -> ${extractIds.length} eligible for extraction`,
      );
    }
  }

  private async persistMeta(
    source: BrandPresenceSource,
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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

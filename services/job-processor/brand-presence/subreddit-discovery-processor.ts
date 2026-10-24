import type { SupabaseClient } from '@supabase/supabase-js';
import {
  proposeSubreddits,
  selectSubreddits,
} from '@/lib/brand-presence/subreddit-discovery';
import type {
  ProfileMeta,
  SubredditDiscoveryCheckpoint,
  VerifiedCommunity,
} from '@/lib/brand-presence/types';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import { buildCommunityVerifyInput } from '@/services/brand-presence/reddit-actor-input';
import {
  RedditApifyProvider,
  RedditProviderError,
} from '@/services/brand-presence/reddit-apify-provider';
import { normalizeRedditItem } from '@/services/brand-presence/reddit-normalizer';
import type { FunctionTimeoutTracker } from '../function-timeout';
import type { Job } from '../types';
import { enqueueBrandPresenceScrape } from './queue';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceSubredditsPayloadSchema } from './types';

interface ProfileRow {
  id: string;
  organization_id: string;
  brand_name: string;
  product_description: string | null;
  category: string | null;
  competitors: string[];
  status: string;
  meta: ProfileMeta;
}

/**
 * brand_presence_reddit_subreddits — runs after the founder confirms the
 * profile. Three phases, checkpointed in profile.meta.subredditDiscovery so
 * a killed worker resumes where it left off:
 *   propose: LLM proposes candidate subreddits + category keywords
 *            (candidates only — LLMs hallucinate subreddit names).
 *   verify:  one actor run (searchCommunities) resolves keywords AND the
 *            candidate names to REAL communities with member counts.
 *   select:  LLM picks the top 4-6 verified communities (core|adjacent) ->
 *            one reddit_subreddit source row each -> enqueue their scrapes.
 */
export class BrandPresenceSubredditDiscoveryProcessor {
  private providerInstance: RedditApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: RedditApifyProvider,
  ) {
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
    const payload = brandPresenceSubredditsPayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId } = payload;
    const label = `[BrandPresence] Subreddit discovery ${brandProfileId}`;

    const profile = await this.loadProfile(organizationId, brandProfileId);
    if (!profile) {
      console.log(`${label}: profile not found, skipping`);
      return;
    }
    if (profile.status !== 'confirmed') {
      console.log(`${label}: profile not confirmed yet, skipping`);
      return;
    }

    const meta: ProfileMeta = { ...(profile.meta ?? {}) };
    let checkpoint: SubredditDiscoveryCheckpoint =
      meta.subredditDiscovery ?? { phase: 'propose' };
    meta.subredditDiscovery = checkpoint;

    if (checkpoint.phase === 'propose') {
      const proposal = await proposeSubreddits(
        {
          brand_name: profile.brand_name,
          product_description: profile.product_description,
          category: profile.category,
          competitors: profile.competitors,
        },
        { signal },
      );
      checkpoint = {
        phase: 'verify',
        candidates: proposal.candidates,
        keywords: proposal.keywords,
        runId: null,
        datasetId: null,
        runStartedAt: null,
      };
      meta.subredditDiscovery = checkpoint;
      await this.persistMeta(profile, meta);
      console.log(
        `${label}: proposed ${proposal.candidates.length} candidates, ${proposal.keywords.length} keywords`,
      );
    }

    if (checkpoint.phase === 'verify') {
      const verified = await this.runVerification(
        profile,
        meta,
        checkpoint,
        signal,
        timeoutTracker,
        label,
      );
      checkpoint = {
        phase: 'select',
        candidates: checkpoint.candidates,
        keywords: checkpoint.keywords,
        verifiedCommunities: verified,
        runId: null,
        datasetId: null,
        runStartedAt: null,
      };
      meta.subredditDiscovery = checkpoint;
      await this.persistMeta(profile, meta);
      console.log(`${label}: verified ${verified.length} real communities`);
    }

    // phase === 'select'
    const verified = checkpoint.verifiedCommunities ?? [];
    if (verified.length === 0) {
      console.warn(
        `${label}: no verified communities — clearing checkpoint without sources`,
      );
      delete meta.subredditDiscovery;
      await this.persistMeta(profile, meta);
      return;
    }

    const selected = await selectSubreddits(
      {
        brand_name: profile.brand_name,
        product_description: profile.product_description,
        category: profile.category,
      },
      checkpoint.candidates ?? [],
      verified,
      { signal },
    );

    const nowIso = new Date().toISOString();
    for (const pick of selected) {
      const { data: sourceRow, error: sourceError } = await this._db
        .from('brand_presence_sources')
        .upsert(
          {
            organization_id: organizationId,
            brand_profile_id: brandProfileId,
            source_type: 'reddit_subreddit',
            uri: `r/${pick.name}`,
            label: `r/${pick.name} (${pick.classification})`,
            status: 'pending',
            meta: { classification: pick.classification },
            updated_at: nowIso,
          },
          {
            onConflict: 'brand_profile_id,source_type,uri',
            // A re-run must not reset a source that already synced.
            ignoreDuplicates: true,
          },
        )
        .select('id')
        .maybeSingle();
      if (sourceError) throw sourceError;

      // ignoreDuplicates returns no row for pre-existing sources — load it so
      // the scrape enqueue below still targets the right id (idempotent via
      // the scrape dedupe key).
      let sourceId = sourceRow ? String(sourceRow.id) : null;
      if (!sourceId) {
        const { data: existing, error: existingError } = await this._db
          .from('brand_presence_sources')
          .select('id')
          .eq('organization_id', organizationId)
          .eq('brand_profile_id', brandProfileId)
          .eq('source_type', 'reddit_subreddit')
          .eq('uri', `r/${pick.name}`)
          .maybeSingle();
        if (existingError) throw existingError;
        sourceId = existing ? String(existing.id) : null;
      }
      if (!sourceId) continue;

      await enqueueBrandPresenceScrape(this._db, {
        organizationId,
        brandProfileId,
        sourceId,
      });
    }

    delete meta.subredditDiscovery;
    await this.persistMeta(profile, meta);
    console.log(
      `${label}: selected ${selected.length} subreddits (${selected
        .map((pick) => `r/${pick.name}:${pick.classification}`)
        .join(', ')})`,
    );
  }

  /** Runs (or resumes) the searchCommunities verification actor run. */
  private async runVerification(
    profile: ProfileRow,
    meta: ProfileMeta,
    checkpoint: SubredditDiscoveryCheckpoint,
    signal: AbortSignal,
    timeoutTracker: FunctionTimeoutTracker | undefined,
    label: string,
  ): Promise<VerifiedCommunity[]> {
    if (!checkpoint.runId) {
      // Verify the LLM's candidate names alongside the category keywords —
      // a real candidate community surfaces itself in the search results.
      const searches = [
        ...(checkpoint.keywords ?? []),
        ...(checkpoint.candidates ?? []),
      ];
      const handle = await this.provider.startRun(
        buildCommunityVerifyInput(searches),
      );
      checkpoint.runId = handle.runId;
      checkpoint.datasetId = handle.datasetId;
      checkpoint.runStartedAt = new Date().toISOString();
      await this.persistMeta(profile, meta);
      console.log(`${label}: started verification run ${handle.runId}`);
    }

    const outcome = await awaitRunCompletion({
      provider: this.provider,
      runId: checkpoint.runId,
      runStartedAt: checkpoint.runStartedAt ?? new Date().toISOString(),
      signal,
      timeoutTracker,
      label,
    });
    if (outcome.outcome === 'failed') {
      checkpoint.runId = null;
      checkpoint.datasetId = null;
      checkpoint.runStartedAt = null;
      await this.persistMeta(profile, meta);
      throw new RedditProviderError(
        `Community verification run failed${outcome.wedged ? ' (wedged)' : ''}`,
        { retryable: outcome.retryable },
      );
    }

    const communities = new Map<string, VerifiedCommunity>();
    const pageSize = BRAND_PRESENCE_CONFIG.datasetPageSize;
    let offset = 0;
    for (;;) {
      const items = await this.provider.listDatasetItems(
        checkpoint.datasetId!,
        offset,
        pageSize,
      );
      for (const item of items) {
        const normalized = normalizeRedditItem(item);
        if (normalized.kind !== 'community') continue;
        const key = normalized.community.name.toLowerCase();
        if (!communities.has(key)) {
          communities.set(key, normalized.community);
        }
      }
      offset += items.length;
      if (items.length < pageSize) break;
    }
    return [...communities.values()];
  }

  private async loadProfile(
    organizationId: string,
    brandProfileId: string,
  ): Promise<ProfileRow | null> {
    const { data, error } = await this._db
      .from('brand_presence_profiles')
      .select(
        'id, organization_id, brand_name, product_description, category, competitors, status, meta',
      )
      .eq('id', brandProfileId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: String(data.id),
      organization_id: String(data.organization_id),
      brand_name: String(data.brand_name),
      product_description: (data.product_description as string | null) ?? null,
      category: (data.category as string | null) ?? null,
      competitors: Array.isArray(data.competitors)
        ? (data.competitors as unknown[]).filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
      status: String(data.status),
      meta: (data.meta as ProfileMeta) ?? {},
    };
  }

  private async persistMeta(
    profile: ProfileRow,
    meta: ProfileMeta,
  ): Promise<void> {
    const { error } = await this._db
      .from('brand_presence_profiles')
      .update({ meta, updated_at: new Date().toISOString() })
      .eq('id', profile.id)
      .eq('organization_id', profile.organization_id);
    if (error) throw error;
  }
}

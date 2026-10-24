/**
 * Pipeline-finalize side effects that run once the relevance gate has drained
 * every pending mention for a profile: auto-promote the subreddits where the
 * brand actually gets mentioned into tracked sources, then enqueue the
 * phrase-extraction pass. Both are idempotent and safe to call after every
 * relevance batch — they no-op while other relevance batches are still
 * in flight. Pending mentions with NO active batch covering them are
 * stragglers (the LLM dropped their verdict, or their job died past
 * max_attempts) and are swept back into a fresh batch — without this, one
 * malformed verdict permanently stalls extraction for the whole brand.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import type { MentionTags } from '@/lib/brand-presence/types';
import { normalizeSubredditName } from '@/services/brand-presence/reddit-actor-input';
import {
  enqueueBrandPresenceScrape,
  enqueueExtractOrDrainCluster,
  enqueueRelevanceBatches,
} from './queue';
import { BRAND_PRESENCE_RELEVANCE_JOB_TYPE } from './types';

/** Sweep retries per straggler before the conservative default applies. */
const GATE_SWEEP_CAP = 2;

interface PendingMentionRow {
  id: string;
  tags: MentionTags | null;
}

/** Mentions still awaiting the relevance gate (id + tags for sweep counts). */
async function loadPendingMentions(
  db: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
): Promise<PendingMentionRow[]> {
  const { data, error } = await db
    .from('brand_mentions')
    .select('id, tags')
    .eq('organization_id', organizationId)
    .eq('brand_profile_id', brandProfileId)
    .eq('relevance', 'pending')
    .limit(2000);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: String(row.id),
    tags: (row.tags as MentionTags | null) ?? null,
  }));
}

/**
 * Whether another relevance batch is still queued/running for this brand.
 * The caller's OWN job row is still 'processing' while its finalize runs, so
 * it must be excluded — otherwise the sweep below could never fire.
 */
async function hasOtherActiveRelevanceJobs(
  db: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
  excludeJobId?: string,
): Promise<boolean> {
  let query = db
    .from('job_queue')
    .select('id')
    .eq('type', BRAND_PRESENCE_RELEVANCE_JOB_TYPE)
    .eq('organization_id', organizationId)
    .eq('payload->>brandProfileId', brandProfileId)
    .in('status', ['pending', 'processing'])
    .limit(2);
  if (excludeJobId) query = query.neq('id', excludeJobId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Promote subreddits where the brand actually gets mentioned into tracked
 * reddit_subreddit sources so their category discussion is analyzed. A sub
 * needs at least `minRelevantBrandMentions` RELEVANT brand mentions; no more
 * than `maxSubreddits` are tracked in total. LLM selection and auto-promotion
 * share this one budget, which also terminates promote -> scrape -> relevance
 * -> promote recursion.
 */
export async function autoPromoteSubreddits(
  db: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
  label: string,
): Promise<number> {
  const { maxSubreddits, minRelevantBrandMentions } =
    BRAND_PRESENCE_CONFIG.autoPromote;

  // Existing subreddit sources are both the dedupe target and the total paid
  // community budget. Do not give auto-promoted rows a second allowance.
  const { data: sources, error: sourcesError } = await db
    .from('brand_presence_sources')
    .select('uri, meta')
    .eq('organization_id', organizationId)
    .eq('brand_profile_id', brandProfileId)
    .eq('source_type', 'reddit_subreddit');
  if (sourcesError) throw sourcesError;
  const trackedUris = new Set(
    (sources ?? []).map((row) =>
      normalizeSubredditName(String(row.uri ?? '')).toLowerCase(),
    ),
  );
  let budget = maxSubreddits - (sources ?? []).length;
  if (budget <= 0) return 0;

  // Relevant brand mentions carry the subreddits worth tracking. Tally counts
  // per subreddit in-process (small N — capped by the relevance corpus).
  const { data: mentions, error: mentionsError } = await db
    .from('brand_mentions')
    .select('subreddit')
    .eq('organization_id', organizationId)
    .eq('brand_profile_id', brandProfileId)
    .eq('scope', 'brand')
    .eq('relevance', 'relevant')
    .not('subreddit', 'is', null)
    .limit(5000);
  if (mentionsError) throw mentionsError;
  const counts = new Map<string, { name: string; count: number }>();
  for (const row of mentions ?? []) {
    const name = normalizeSubredditName(String(row.subreddit ?? ''));
    if (!name) continue;
    const key = name.toLowerCase();
    if (trackedUris.has(key)) continue;
    const entry = counts.get(key) ?? { name, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }

  const candidates = [...counts.values()]
    .filter((entry) => entry.count >= minRelevantBrandMentions)
    .sort((a, b) => b.count - a.count)
    .slice(0, budget);

  const nowIso = new Date().toISOString();
  let promoted = 0;
  for (const candidate of candidates) {
    if (budget <= 0) break;
    const uri = `r/${candidate.name}`;
    const { data: sourceRow, error: sourceError } = await db
      .from('brand_presence_sources')
      .upsert(
        {
          organization_id: organizationId,
          brand_profile_id: brandProfileId,
          source_type: 'reddit_subreddit',
          uri,
          label: `r/${candidate.name} (core)`,
          status: 'pending',
          meta: {
            classification: 'core',
            discoveredVia: 'brand_mentions',
          },
          updated_at: nowIso,
        },
        {
          onConflict: 'brand_profile_id,source_type,uri',
          ignoreDuplicates: true,
        },
      )
      .select('id')
      .maybeSingle();
    if (sourceError) throw sourceError;

    // ignoreDuplicates returns no row for a pre-existing source — a concurrent
    // batch may have added it; skip enqueuing (its own promotion handled it).
    if (!sourceRow) continue;
    budget -= 1;
    promoted += 1;
    await enqueueBrandPresenceScrape(db, {
      organizationId,
      brandProfileId,
      sourceId: String(sourceRow.id),
    });
  }
  if (promoted > 0) {
    console.log(
      `${label}: auto-promoted ${promoted} subreddit(s) from brand mentions (${candidates
        .map((c) => `r/${c.name}:${c.count}`)
        .join(', ')})`,
    );
  }
  return promoted;
}

/**
 * Run once the relevance gate has drained: promote brand-mention subreddits,
 * then enqueue phrase extraction over every kept mention still awaiting it.
 * While OTHER relevance batches are in flight this is a no-op (a later batch
 * finalizes). Pending mentions with no batch covering them are stragglers:
 * swept back into a fresh batch up to GATE_SWEEP_CAP times (tags.gateSweeps),
 * then defaulted to irrelevant — the gate's own "when you cannot tell, mark
 * relevant=false" rule — so one dropped verdict can never stall the pipeline.
 */
export async function finalizeIfDrained(
  db: SupabaseClient,
  organizationId: string,
  brandProfileId: string,
  label: string,
  // REQUIRED: the caller's own job row is still 'processing' during finalize,
  // so both the straggler-sweep probe and the final theme-rebuild drain check
  // see the caller itself unless it is excluded. Omitting it makes both a
  // permanent no-op.
  opts: { excludeJobId: string },
): Promise<void> {
  const pending = await loadPendingMentions(db, organizationId, brandProfileId);
  if (pending.length > 0) {
    const active = await hasOtherActiveRelevanceJobs(
      db,
      organizationId,
      brandProfileId,
      opts.excludeJobId,
    );
    if (active) return;

    const retry: PendingMentionRow[] = [];
    const exhausted: string[] = [];
    for (const mention of pending) {
      const sweeps = Number(mention.tags?.gateSweeps ?? 0);
      if (sweeps >= GATE_SWEEP_CAP) exhausted.push(mention.id);
      else retry.push(mention);
    }

    if (retry.length > 0) {
      for (const mention of retry) {
        const sweeps = Number(mention.tags?.gateSweeps ?? 0);
        const { error } = await db
          .from('brand_mentions')
          .update({ tags: { ...(mention.tags ?? {}), gateSweeps: sweeps + 1 } })
          .eq('id', mention.id)
          .eq('organization_id', organizationId)
          // Guard: a concurrent decision means no sweep is needed.
          .eq('relevance', 'pending');
        if (error) throw error;
      }
      const { jobIds } = await enqueueRelevanceBatches(db, {
        organizationId,
        brandProfileId,
        mentionIds: retry.map((mention) => mention.id),
      });
      console.warn(
        `${label}: swept ${retry.length} straggler mention(s) with no active batch back into ${jobIds.length} relevance batch(es)`,
      );
      return;
    }

    // Every straggler exhausted its sweeps — conservative default so the
    // pipeline drains deterministically instead of deadlocking.
    const { error } = await db
      .from('brand_mentions')
      .update({ relevance: 'irrelevant', extraction_status: 'skipped' })
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .in('id', exhausted)
      .eq('relevance', 'pending');
    if (error) throw error;
    console.warn(
      `${label}: defaulted ${exhausted.length} unjudgeable straggler(s) to irrelevant after ${GATE_SWEEP_CAP} sweeps`,
    );
  }

  await autoPromoteSubreddits(db, organizationId, brandProfileId, label);

  const { extractIds, batches } = await enqueueExtractOrDrainCluster(db, {
    organizationId,
    brandProfileId,
    excludeJobId: opts.excludeJobId,
  });
  if (!batches) return;
  console.log(
    `${label}: enqueued ${batches.jobIds.length} extract batch(es) over ${extractIds.length} mentions (${batches.deduped} deduped)`,
  );
}

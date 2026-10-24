import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import { groupPhrases } from '@/lib/brand-presence/theme-grouping';
import { labelThemes, type ThemeToLabel } from '@/lib/brand-presence/theme-labels';
import {
  applyThemeMerges,
  proposeThemeMerges,
  type ThemeForMerge,
} from '@/lib/brand-presence/theme-merge';
import {
  buildDraftsFromGroupings,
  clusterPartitionAdaptive,
  type PartitionGrouping,
  type PhraseForClustering,
  type ThemeDraft,
} from '@/lib/brand-presence/themes';
import {
  THEME_KINDS,
  type PhraseScope,
  type ThemeKind,
} from '@/lib/brand-presence/types';
import { parseVectorLiteral } from '@/services/ad-library/embeddings';
import { maybeEnqueuePromoteAfterCluster } from '../brand-object/queue';
import type { FunctionTimeoutTracker } from '../function-timeout';
import type { Job } from '../types';
import { brandPresenceClusterPayloadSchema } from './types';

const PHRASE_FETCH_CHUNK = 200;
const REPOINT_CHUNK = 100;
const CATCHALL_LABEL: Record<ThemeKind, string> = {
  pain: 'Other pains',
  desire: 'Other desires',
  objection: 'Other objections',
  praise: 'Other praise',
};

/**
 * brand_presence_cluster — full per-brand rebuild of the DERIVED theme layer,
 * grouping phrases by MEANING into a corpus-adaptive number of angles.
 * Phrases partition by (kind × scope) — cross-partition merges are
 * impossible. Per partition:
 *   - small (<= cluster.smallCorpusMaxPhrases): ONE cheap-model call groups
 *     phrases directly and names the groups (theme-grouping.ts); on LLM
 *     failure the partition falls back to the embedding path below.
 *   - large: adaptive-cut UPGMA over phrase embeddings (themes.ts
 *     clusterPartitionAdaptive, reusing the SHARED ad-clustering machinery —
 *     lib/brand-identity/clustering.ts clusterFamiliesAdaptive) targeting
 *     ~sqrt(N/2) angles; leftovers attach to the nearest angle centroid or
 *     pool into the partition catch-all (no standalone 1-phrase themes).
 * Unlabeled drafts get batched cheap-model labels; when
 * cluster.mergeRefinement is enabled, a per-partition synonym-merge pass
 * fuses embedding-path angles the cosine threshold missed. Then the ONE
 * SANCTIONED DELETE in Layer 2 — the crash-safe transaction-free rebuild,
 * ordered so no state is ever unrecoverable:
 *   1. INSERT the new themes under a fresh cluster_run_id.
 *   2. Repoint phrases.theme_id at the new rows (chunked).
 *   3. DELETE this brand's themes where cluster_run_id != the new run.
 * A crash after (1) leaves orphan new-run rows that step (3) of the NEXT run
 * removes; a crash between (2) and (3) leaves stale rows whose deletion
 * SET-NULLs nothing (phrases already point at the new run). Mentions and
 * phrases are source data and are NEVER deleted here.
 */
export class BrandPresenceClusterProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceClusterPayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId } = payload;
    const label = `[BrandPresence] Cluster ${brandProfileId}`;
    const cfg = BRAND_PRESENCE_CONFIG.cluster;

    const phrases = await this.loadEmbeddedPhrases(
      organizationId,
      brandProfileId,
    );
    if (phrases.length === 0) {
      console.log(`${label}: no embedded phrases, nothing to cluster`);
      return;
    }

    // Partition by (kind × scope); insertion order keeps runs deterministic.
    const partitions = new Map<string, PhraseForClustering[]>();
    for (const phrase of phrases) {
      const key = `${phrase.kind}:${phrase.scope}`;
      const list = partitions.get(key);
      if (list) list.push(phrase);
      else partitions.set(key, [phrase]);
    }

    // Group each partition: small ones via one LLM call (embedding fallback),
    // large ones via adaptive-cut UPGMA + attach-or-pool.
    const groupings: PartitionGrouping[] = [];
    /** Partition keys grouped by the LLM (skip label + merge passes). */
    const llmGroupedKeys = new Set<string>();
    let llmGroupCalls = 0;
    for (const [key, partition] of partitions) {
      if (signal.aborted) throw new Error('Brand presence job aborted');
      const { kind, scope } = partition[0];
      let grouping: PartitionGrouping | null = null;

      if (
        partition.length >= cfg.minClusterSize &&
        partition.length <= cfg.smallCorpusMaxPhrases
      ) {
        try {
          const llmGroups = await groupPhrases(
            kind,
            scope,
            partition.map((phrase, index) => ({
              index,
              text: phrase.paraphrase ?? phrase.phrase,
            })),
            { signal },
          );
          llmGroupCalls++;
          const assigned = new Set<number>();
          const groups = llmGroups.map((group) => {
            group.phraseIndexes.forEach((index) => assigned.add(index));
            return {
              members: group.phraseIndexes.map((index) => partition[index]),
              label: group.label,
              summary: group.summary,
            };
          });
          grouping = {
            kind,
            scope,
            groups,
            catchallMembers: partition.filter(
              (_, index) => !assigned.has(index),
            ),
          };
          llmGroupedKeys.add(key);
        } catch (error) {
          console.warn(
            `${label}: LLM grouping failed for ${key}, falling back to embedding clustering`,
            error,
          );
        }
      }

      if (!grouping) {
        // O(n²) guard: one giant partition must not eat the job budget —
        // overflow beyond the cap pools into the partition catch-all.
        let clusterable = partition;
        let overflow: PhraseForClustering[] = [];
        if (partition.length > cfg.maxPartitionClusterPhrases) {
          console.warn(
            `${label}: partition ${key} has ${partition.length} phrases — clustering the first ${cfg.maxPartitionClusterPhrases}, pooling the rest into the catch-all`,
          );
          clusterable = partition.slice(0, cfg.maxPartitionClusterPhrases);
          overflow = partition.slice(cfg.maxPartitionClusterPhrases);
        }
        grouping = clusterPartitionAdaptive(clusterable, {
          targetAngles: cfg.targetAngles,
          softCosine: cfg.softCosine,
          mergeFloor: cfg.mergeFloor,
          attachFloor: cfg.attachFloor,
          minClusterSize: cfg.minClusterSize,
        });
        grouping.catchallMembers.push(...overflow);
      }
      groupings.push(grouping);
    }

    const drafts = buildDraftsFromGroupings(groupings, {
      representativeCount: cfg.representativeCount,
    });

    // Batched labeling over drafts the LLM grouping didn't already name;
    // catch-alls get fixed labels, failures fall back to a representative.
    const toLabel: ThemeToLabel[] = [];
    drafts.forEach((draft, index) => {
      if (draft.isCatchall || draft.label != null) return;
      toLabel.push({
        cluster_key: String(index),
        kind: draft.kind,
        phrases: draft.representativeTexts,
      });
    });
    const labels = new Map<string, { label: string; summary: string }>();
    let labelCalls = 0;
    for (let i = 0; i < toLabel.length; i += cfg.labelBatchSize) {
      if (signal.aborted) throw new Error('Brand presence job aborted');
      const batch = toLabel.slice(i, i + cfg.labelBatchSize);
      const batchLabels = await labelThemes(batch, { signal });
      labelCalls++;
      for (const [key, value] of batchLabels) labels.set(key, value);
    }
    for (const [key, value] of labels) {
      const draft = drafts[Number(key)];
      if (!draft) continue;
      draft.label = value.label;
      draft.summary = value.summary;
    }

    // Synonym-merge refinement: per (kind × scope), embedding-path drafts
    // whose labels describe the same theme are fused. Best-effort.
    let finalDrafts = drafts;
    let mergeCalls = 0;
    if (cfg.mergeRefinement.enabled) {
      const phraseById = new Map(phrases.map((phrase) => [phrase.id, phrase]));
      const merged: ThemeDraft[] = [];
      const byPartition = new Map<string, ThemeDraft[]>();
      for (const draft of drafts) {
        const key = `${draft.kind}:${draft.scope}`;
        const list = byPartition.get(key);
        if (list) list.push(draft);
        else byPartition.set(key, [draft]);
      }
      for (const [key, partitionDrafts] of byPartition) {
        if (signal.aborted) throw new Error('Brand presence job aborted');
        const candidates = partitionDrafts.filter(
          (draft) => !draft.isCatchall && draft.label != null,
        );
        if (
          llmGroupedKeys.has(key) ||
          candidates.length < 2 ||
          candidates.length > cfg.mergeRefinement.maxThemesPerCall
        ) {
          merged.push(...partitionDrafts);
          continue;
        }
        const forMerge: ThemeForMerge[] = candidates.map((draft) => ({
          key: String(partitionDrafts.indexOf(draft)),
          label: draft.label as string,
          phrases: draft.representativeTexts,
        }));
        mergeCalls++;
        const proposals = await proposeThemeMerges(
          partitionDrafts[0].kind,
          forMerge,
          { signal },
        );
        merged.push(
          ...applyThemeMerges(partitionDrafts, proposals, phraseById, {
            representativeCount: cfg.representativeCount,
          }),
        );
      }
      finalDrafts = merged;
    }

    // 1) Insert the new run's themes.
    const clusterRunId = randomUUID();
    const rows = finalDrafts.map((draft) => ({
      organization_id: organizationId,
      brand_profile_id: brandProfileId,
      kind: draft.kind,
      scope: draft.scope,
      label: draft.isCatchall
        ? CATCHALL_LABEL[draft.kind]
        : (draft.label ??
          truncateLabel(draft.representativeTexts[0] ?? draft.kind)),
      summary: draft.isCatchall ? null : draft.summary,
      is_catchall: draft.isCatchall,
      frequency: draft.frequency,
      mention_count: draft.mentionCount,
      avg_sentiment: draft.avgSentiment,
      representative_phrase_ids: draft.representativePhraseIds,
      cluster_run_id: clusterRunId,
    }));
    const { data: inserted, error: insertError } = await this._db
      .from('brand_presence_themes')
      .insert(rows)
      .select('id');
    if (insertError || !inserted || inserted.length !== rows.length) {
      throw insertError ?? new Error('Theme insert returned a short row set');
    }

    // 2) Repoint member phrases at their new theme.
    for (let i = 0; i < finalDrafts.length; i++) {
      const themeId = String(inserted[i].id);
      const phraseIds = finalDrafts[i].phraseIds;
      for (let j = 0; j < phraseIds.length; j += REPOINT_CHUNK) {
        const chunk = phraseIds.slice(j, j + REPOINT_CHUNK);
        const { error } = await this._db
          .from('brand_presence_phrases')
          .update({ theme_id: themeId })
          .eq('organization_id', organizationId)
          .eq('brand_profile_id', brandProfileId)
          .in('id', chunk);
        if (error) throw error;
      }
    }

    // 3) Delete the previous run's themes (the sanctioned derived delete).
    const { error: deleteError } = await this._db
      .from('brand_presence_themes')
      .delete()
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .neq('cluster_run_id', clusterRunId);
    if (deleteError) throw deleteError;

    console.log(
      `${label}: rebuilt ${rows.length} themes over ${phrases.length} phrases (${partitions.size} partitions: ${partitions.size - llmGroupedKeys.size} embedding, ${llmGroupedKeys.size} llm-grouped; run ${clusterRunId}, ${llmGroupCalls} group + ${labelCalls} label + ${mergeCalls} merge LLM calls)`,
    );

    // Layer-3 hook: threshold-gated, opt-in (no brand_object_state row = no
    // Brand Object), and fail-soft — a hook failure never fails this job.
    try {
      await maybeEnqueuePromoteAfterCluster(this._db, {
        organizationId,
        brandProfileId,
        clusterRunId,
      });
    } catch (error) {
      console.warn(`${label}: brand-object promote hook failed (non-fatal)`, error);
    }
  }

  /** Chunk-loads embedded clusterable phrases (vector literals are ~15-20KB
   * per row), capped at cluster.maxPhrases. */
  private async loadEmbeddedPhrases(
    organizationId: string,
    brandProfileId: string,
  ): Promise<PhraseForClustering[]> {
    const { maxPhrases } = BRAND_PRESENCE_CONFIG.cluster;
    const out: PhraseForClustering[] = [];
    let lastId: string | null = null;
    while (out.length < maxPhrases) {
      let query = this._db
        .from('brand_presence_phrases')
        .select('id, mention_id, kind, scope, phrase, paraphrase, sentiment, embedding')
        .eq('organization_id', organizationId)
        .eq('brand_profile_id', brandProfileId)
        .neq('kind', 'quote')
        .not('embedding', 'is', null)
        .order('id', { ascending: true })
        .limit(PHRASE_FETCH_CHUNK);
      if (lastId) query = query.gt('id', lastId);
      const { data, error } = await query;
      if (error) throw error;
      const page = data ?? [];
      for (const row of page) {
        const vector = parseVectorLiteral(row.embedding);
        const kind = String(row.kind) as ThemeKind;
        if (!vector || !(THEME_KINDS as readonly string[]).includes(kind)) {
          continue;
        }
        out.push({
          id: String(row.id),
          mentionId: String(row.mention_id),
          kind,
          scope: String(row.scope) as PhraseScope,
          phrase: String(row.phrase),
          paraphrase: (row.paraphrase as string | null) ?? null,
          sentiment: row.sentiment == null ? null : Number(row.sentiment),
          vector,
        });
      }
      if (page.length < PHRASE_FETCH_CHUNK) break;
      lastId = String(page[page.length - 1].id);
    }
    if (out.length >= maxPhrases) {
      console.warn(
        `[BrandPresence] Cluster ${brandProfileId}: phrase cap ${maxPhrases} reached — oldest phrases beyond the cap are not clustered this run`,
      );
    }
    return out;
  }
}

function truncateLabel(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

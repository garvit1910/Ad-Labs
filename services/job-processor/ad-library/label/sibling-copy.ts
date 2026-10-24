import type { SupabaseClient } from '@supabase/supabase-js';
import { LABEL_TAXONOMY_VERSION } from '@/services/ad-library/label-taxonomy';
import type { AdToLabel, SiblingLibraryAd } from './types';

/** Max ids per PostgREST `.in()` filter to stay within URL/statement limits. */
const SIBLING_LOOKUP_CHUNK = 100;

/**
 * Row-scoped columns of an `ad_labels` row that must NOT be copied across orgs:
 * the primary key, the two ownership keys (reassigned to OUR ad/org), the
 * insert timestamp (fresh on our upsert), and the per-row agentic provenance
 * slots (`tags` is rewritten with copy provenance; scores/constraints/history
 * describe the sibling row, not the labeling event). `labeled_at` and `model`
 * are KEPT — they describe the actual labeling event, which we are reusing.
 * (`ad_labels` has no `updated_at` column; the spec's list is a superset.)
 */
const LABEL_ROW_SCOPED_COLUMNS = [
  'id',
  'library_ad_id',
  'organization_id',
  'created_at',
  'updated_at',
  'tags',
  'scores',
  'entity_constraints',
  'edit_history',
] as const;

/** Reads the stamped taxonomy version from a sibling `ad_labels` row's tags slot. */
function siblingTaxonomyVersion(label: Record<string, unknown>): number | null {
  const tags =
    label.tags && typeof label.tags === 'object'
      ? (label.tags as Record<string, unknown>)
      : null;
  const version = tags?.taxonomyVersion;
  return typeof version === 'number' ? version : null;
}

/**
 * Builds an `ad_labels` row for OUR ad from a sibling's row: strips the
 * row-scoped columns, reassigns the ownership keys to us, keeps the sibling's
 * `labeled_at`/`model` (they describe the real labeling event), and records
 * copy provenance in the `tags` slot.
 */
function buildCopiedLabelRow(
  siblingLabel: Record<string, unknown>,
  ad: AdToLabel,
  organizationId: string
): Record<string, unknown> {
  const siblingAdId = String(siblingLabel.library_ad_id ?? '');
  const existingTags =
    siblingLabel.tags && typeof siblingLabel.tags === 'object'
      ? (siblingLabel.tags as Record<string, unknown>)
      : {};
  const copy: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(siblingLabel)) {
    if ((LABEL_ROW_SCOPED_COLUMNS as readonly string[]).includes(column)) {
      continue;
    }
    copy[column] = value;
  }
  copy.organization_id = organizationId;
  copy.library_ad_id = ad.id;
  copy.tags = {
    ...existingTags,
    taxonomyVersion: LABEL_TAXONOMY_VERSION,
    copiedFromLibraryAdId: siblingAdId,
  };
  return copy;
}

/**
 * Copies a sibling org's `ad_labels` row for any of OUR unlabeled ads that
 * another org already labeled for the SAME public creative
 * (`(platform, external_ad_id)` match) under a competitor whose industry
 * equals OUR ad's competitor industry (null === null counts as equal — the
 * `angle` vocabulary is industry-specific, so an industry mismatch would copy
 * an out-of-vocabulary angle). When several siblings qualify, the most recent
 * by `labeled_at` wins.
 *
 * Returns the set of OUR ad ids whose labels were successfully upserted from a
 * sibling (excluded from LLM planning). Fails OPEN: on any read/write error it
 * warns and returns an EMPTY set, so every ad falls through to the normal LLM
 * path — the copy is a cost optimization, never a correctness dependency.
 */
export async function copySiblingLabels(
  db: SupabaseClient,
  organizationId: string,
  toLabel: AdToLabel[],
  industryByAd: Map<string, string | null>,
  jobId: string
): Promise<Set<string>> {
  const copied = new Set<string>();
  try {
    const externalIds = Array.from(
      new Set(
        toLabel
          .map((ad) => ad.external_ad_id)
          .filter((id): id is string => !!id)
      )
    );
    if (externalIds.length === 0) return copied;

    // 1) Sibling library_ads (a DIFFERENT org) tracking any of our external
    //    ad ids. Platform is matched in code (below), not in the query.
    const siblings: SiblingLibraryAd[] = [];
    for (let i = 0; i < externalIds.length; i += SIBLING_LOOKUP_CHUNK) {
      const chunk = externalIds.slice(i, i + SIBLING_LOOKUP_CHUNK);
      const { data, error } = await db
        .from('library_ads')
        .select('id, organization_id, platform, external_ad_id, competitor_id')
        .neq('organization_id', organizationId)
        .in('external_ad_id', chunk);
      if (error) throw error;
      siblings.push(...((data ?? []) as SiblingLibraryAd[]));
    }
    if (siblings.length === 0) return copied;

    // 2) Those siblings' label rows (full row — we strip row-scoped columns
    //    below rather than enumerate the copyable ones).
    const siblingAdIds = Array.from(new Set(siblings.map((s) => s.id)));
    const siblingLabels: Record<string, unknown>[] = [];
    for (let i = 0; i < siblingAdIds.length; i += SIBLING_LOOKUP_CHUNK) {
      const chunk = siblingAdIds.slice(i, i + SIBLING_LOOKUP_CHUNK);
      const { data, error } = await db
        .from('ad_labels')
        .select('*')
        .in('library_ad_id', chunk);
      if (error) throw error;
      siblingLabels.push(...((data ?? []) as Record<string, unknown>[]));
    }
    if (siblingLabels.length === 0) return copied;
    const labelBySiblingAdId = new Map(
      siblingLabels.map((row) => [String(row.library_ad_id), row])
    );

    // 3) Industry for the SIBLING competitors (our side is already resolved in
    //    industryByAd). Read across ALL orgs (siblings belong to other orgs).
    const siblingCompetitorIds = Array.from(
      new Set(
        siblings
          .map((s) => s.competitor_id)
          .filter((id): id is string => !!id)
      )
    );
    const industryBySiblingCompetitor = new Map<string, string | null>();
    for (let i = 0; i < siblingCompetitorIds.length; i += SIBLING_LOOKUP_CHUNK) {
      const chunk = siblingCompetitorIds.slice(i, i + SIBLING_LOOKUP_CHUNK);
      const { data, error } = await db
        .from('tracked_competitors')
        .select('id, industry')
        .in('id', chunk);
      if (error) throw error;
      for (const row of (data ?? []) as Array<{ id: string; industry: string | null }>) {
        industryBySiblingCompetitor.set(String(row.id), row.industry ?? null);
      }
    }

    // Index qualified sibling labels by (platform, external_ad_id) so each of
    // our ads can look up candidates, then pick the most recent labeled_at.
    const candidatesByKey = new Map<
      string,
      Array<{ label: Record<string, unknown>; labeledAt: string; industry: string | null }>
    >();
    for (const sibling of siblings) {
      const label = labelBySiblingAdId.get(sibling.id);
      if (!label) continue;
      const industry = sibling.competitor_id
        ? industryBySiblingCompetitor.get(sibling.competitor_id) ?? null
        : null;
      const key = `${sibling.platform ?? ''}::${sibling.external_ad_id ?? ''}`;
      const list = candidatesByKey.get(key) ?? [];
      list.push({
        label,
        labeledAt: String(label.labeled_at ?? ''),
        industry,
      });
      candidatesByKey.set(key, list);
    }

    const rowsToUpsert: Record<string, unknown>[] = [];
    for (const ad of toLabel) {
      if (!ad.external_ad_id) continue;
      const ourIndustry = industryByAd.get(ad.id) ?? null;
      const key = `${ad.platform ?? ''}::${ad.external_ad_id}`;
      const candidates = (candidatesByKey.get(key) ?? []).filter(
        // null === null counts as equal AND the sibling must be labelled with
        // the CURRENT taxonomy version — copying a stale-taxonomy row would
        // carry forward missing/outdated persona/funnel/format values.
        (c) => c.industry === ourIndustry && siblingTaxonomyVersion(c.label) === LABEL_TAXONOMY_VERSION
      );
      if (candidates.length === 0) continue;
      // Most recent labeling event wins.
      const best = candidates.reduce((a, b) =>
        b.labeledAt > a.labeledAt ? b : a
      );
      rowsToUpsert.push(buildCopiedLabelRow(best.label, ad, organizationId));
      copied.add(ad.id);
    }

    if (rowsToUpsert.length > 0) {
      const { error: upsertError } = await db
        .from('ad_labels')
        .upsert(rowsToUpsert, { onConflict: 'library_ad_id' });
      if (upsertError) throw upsertError;
    }

    return copied;
  } catch (err) {
    console.warn(
      `[AdLibLabel] Job ${jobId}: sibling label copy failed, labelling remaining ads directly`,
      err
    );
    // Reset so ambiguous partial state can't skip an LLM call: any ad without
    // a proven upserted row is (re)labelled below.
    copied.clear();
    return copied;
  }
}

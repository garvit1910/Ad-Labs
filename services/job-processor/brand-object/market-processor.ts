/**
 * brand_object_market — ZERO-LLM category priors from EXISTING ad_labels
 * over winner-gated competitor ads (library_ads_enriched), replication-
 * deduped via read-time cosine clustering. Layer-1 data is ORG-scoped, so
 * every brand profile in an org derives priors from the same competitor set.
 * Fingerprint + cooldown gated; too few winners = skip (never a failure).
 * Stale auto candidates retire on re-derivation (identity pattern). The
 * optional LLM narration pass is deliberately deferred — the deterministic
 * aggregate IS the fact layer, and the LLM never sources numbers anyway.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_OBJECT_CONFIG } from '@/lib/brand-object/config';
import {
  computeCompleteness,
  deriveStatus,
} from '@/lib/brand-object/completeness';
import {
  distillMarketPriors,
  type AdVector,
  type LabeledEnrichedAd,
} from '@/lib/brand-object/market';
import { reconcileFacts } from '@/lib/brand-object/reconciler';
import {
  EMBEDDING_MODEL,
  parseVectorLiteral,
} from '@/services/ad-library/embeddings';
import type { Job } from '../types';
import {
  executeReconcilePlan,
  loadLiveFacts,
  loadRejectedKeys,
  retireFacts,
} from './fact-writer';
import { enqueueBrandObjectChunks, enqueueBrandObjectPersonas } from './queue';
import { ensureBrandObjectState, mergeBrandObjectState } from './state';
import { brandObjectMarketPayloadSchema } from './types';

const AD_ROW_CAP = 2000;
/** PostgREST's per-response row cap. */
const AD_PAGE_SIZE = 1000;
const IN_CHUNK = 150;

export class BrandObjectMarketProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(job: Job, _signal: AbortSignal): Promise<void> {
    const payload = brandObjectMarketPayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, chain } = payload;
    const label = `[BrandObject] Market ${brandProfileId}`;
    const cfg = BRAND_OBJECT_CONFIG.market;

    const state = await ensureBrandObjectState(
      this._db,
      organizationId,
      brandProfileId,
    );

    const { ads, competitorLastSyncedAt } = await this.loadLabeledAds(
      organizationId,
      brandProfileId,
    );
    const vectors = await this.loadVectors(
      organizationId,
      ads.map((ad) => ad.id),
    );
    const forbiddenNames = await this.loadForbiddenNames(organizationId, ads);
    const distillation = distillMarketPriors(ads, vectors, EMBEDDING_MODEL, {
      forbiddenNames,
      competitorLastSyncedAt,
    });

    if (distillation.winnerCount < cfg.minWinnerAds) {
      console.log(
        `${label}: only ${distillation.winnerCount} winner ads (< ${cfg.minWinnerAds}) — skipped`,
      );
      await this.chainNext(payload, label, chain);
      return;
    }

    // Fingerprint + cooldown gate (zero-LLM, but the writes churn versions).
    const cursor = state.cursors?.market ?? {};
    const lastRunAt = cursor.lastRunAt ? Date.parse(cursor.lastRunAt) : 0;
    const withinCooldown =
      Date.now() - lastRunAt < cfg.cooldownDays * 24 * 60 * 60 * 1000;
    if (cursor.packFingerprint === distillation.fingerprint && withinCooldown) {
      console.log(`${label}: winner set unchanged within cooldown — skipped`);
      await this.chainNext(payload, label, chain);
      return;
    }

    const liveFacts = await loadLiveFacts(
      this._db,
      organizationId,
      brandProfileId,
      ['market_prior'],
    );
    const rejectedKeys = await loadRejectedKeys(
      this._db,
      organizationId,
      brandProfileId,
      liveFacts,
      ['market_prior'],
    );
    const plan = reconcileFacts({
      candidates: distillation.candidates,
      liveFacts,
      rejectedKeys,
    });
    const counts = await executeReconcilePlan(
      this._db,
      organizationId,
      brandProfileId,
      plan,
    );

    const freshKeys = new Set(
      distillation.candidates.map(
        (candidate) => `${candidate.section}:${candidate.factKey}`,
      ),
    );
    const retired = await retireFacts(
      this._db,
      organizationId,
      brandProfileId,
      liveFacts
        .filter(
          (fact) =>
            fact.status === 'candidate' &&
            fact.source === 'market_distillation' &&
            !freshKeys.has(`${fact.section}:${fact.factKey}`),
        )
        .map((fact) => fact.id),
    );

    const allLive = await loadLiveFacts(
      this._db,
      organizationId,
      brandProfileId,
    );
    const completeness = computeCompleteness(allLive);
    await mergeBrandObjectState(this._db, organizationId, brandProfileId, {
      status: deriveStatus(allLive, completeness),
      completeness,
      cursors: {
        market: {
          packFingerprint: distillation.fingerprint,
          lastRunAt: new Date().toISOString(),
        },
      },
    });

    console.log(
      `${label}: ${counts.inserted} inserted, ${counts.superseded} superseded, ` +
        `${counts.refreshed} refreshed, ${retired} retired from ` +
        `${distillation.winnerCount}/${distillation.totalCount} winner ads`,
    );
    await this.chainNext(payload, label, chain);
  }

  private async chainNext(
    payload: { organizationId: string; brandProfileId: string },
    label: string,
    chain?: boolean,
  ): Promise<void> {
    const scope = {
      organizationId: payload.organizationId,
      brandProfileId: payload.brandProfileId,
    };
    const chunks = await enqueueBrandObjectChunks(this._db, scope);
    console.log(
      `${label}: chunks ${chunks.deduped ? 'already queued' : 'queued'} (${chunks.jobId})`,
    );
    if (!chain) return;
    const personas = await enqueueBrandObjectPersonas(this._db, {
      ...scope,
      chain: true,
    });
    console.log(
      `${label}: personas ${personas.deduped ? 'already queued' : 'queued'} (${personas.jobId})`,
    );
  }

  /** Labeled enriched ads for the org (label columns come from the view's
   * ad_labels join; unlabeled ads have NULL angle and are skipped), plus the
   * competitor id → last_synced_at map that stamps each prior's
   * `metrics.evidenceAsOf` (lib/brand-object/freshness.ts). Both pools read
   * tracked_competitors already, so the map costs no extra round trip. */
  private async loadLabeledAds(
    organizationId: string,
    brandProfileId: string,
  ): Promise<{
    ads: LabeledEnrichedAd[];
    competitorLastSyncedAt: Record<string, string | null>;
  }> {
    const competitorLastSyncedAt: Record<string, string | null> = {};
    // Agency scoping: when the brand has tagged competitors, distill ONLY
    // their ads (keeps a multi-brand org's market chapters industry-clean);
    // zero tags falls back to the org-wide pool verbatim. The tag set needs
    // no fingerprint entry — it changes which ads load, and the fingerprint
    // already hashes the winner ad tuples.
    const { data: tagged, error: taggedError } = await this._db
      .from('tracked_competitors')
      .select('id, is_brand_self, last_synced_at')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .eq('status', 'active');
    if (taggedError) throw taggedError;
    // Market priors are COMPETITIVE signal — the brand's OWN page (is_brand_self)
    // must never count as market. Drop self rows from the tagged set; a brand
    // whose only tag is its own page then falls back to the org-wide pool below.
    const taggedIds = (tagged ?? [])
      .filter((row) => !row.is_brand_self)
      .map((row) => String(row.id));
    for (const row of tagged ?? []) {
      competitorLastSyncedAt[String(row.id)] =
        (row.last_synced_at as string | null) ?? null;
    }

    let selfIds: string[] = [];
    if (taggedIds.length === 0) {
      // Org-wide fallback reads every competitor in the org — so it must also
      // exclude EVERY self page in the org, or a brand with only its own page
      // (no competitors) would distill its own ads as market priors.
      // Reads every org competitor (not just self rows) so the SAME query
      // also yields the evidence-age map for the org-wide pool; the self
      // filter moves to JS and stays behaviorally identical.
      const { data: orgRows, error: selfError } = await this._db
        .from('tracked_competitors')
        .select('id, is_brand_self, last_synced_at')
        .eq('organization_id', organizationId);
      if (selfError) throw selfError;
      for (const row of orgRows ?? []) {
        competitorLastSyncedAt[String(row.id)] =
          (row.last_synced_at as string | null) ?? null;
      }
      selfIds = (orgRows ?? [])
        .filter((row) => row.is_brand_self)
        .map((row) => String(row.id));
    }
    // Ad Lab (REUSE_MANIFEST §11.1): PostgREST caps a response at 1,000 rows,
    // so a bare `.limit(AD_ROW_CAP)` distilled an arbitrary subset. Page in id
    // order until a short page; AD_ROW_CAP stays the total ceiling. Builders
    // mutate (`.order()` appends), so every page builds a fresh query.
    const buildQuery = () => {
      let query = this._db
        .from('library_ads_enriched')
        .select(
          'id, competitor_id, platform, media_type, is_active, longevity_days, num_served_days, eu_total_reach, angle, angle_universal, hook_archetype, format, offer_type, style, aspect_ratio, fingerprint, page_name',
        )
        .eq('organization_id', organizationId)
        .not('hook_archetype', 'is', null);
      if (taggedIds.length > 0) {
        query = query.in('competitor_id', taggedIds);
      } else if (selfIds.length > 0) {
        query = query.not('competitor_id', 'in', `(${selfIds.join(',')})`);
      }
      return query;
    };
    const rows: Record<string, unknown>[] = [];
    while (rows.length < AD_ROW_CAP) {
      const from = rows.length;
      const to = Math.min(from + AD_PAGE_SIZE, AD_ROW_CAP) - 1;
      const { data, error } = await buildQuery()
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      const page = data ?? [];
      rows.push(...page);
      if (page.length < to - from + 1) break;
    }
    const ads = rows.map((row) => ({
      id: String(row.id),
      competitorId: row.competitor_id ? String(row.competitor_id) : null,
      platform: String(row.platform),
      mediaType: (row.media_type as string | null) ?? null,
      isActive: Boolean(row.is_active),
      longevityDays:
        row.longevity_days == null ? null : Number(row.longevity_days),
      numServedDays:
        row.num_served_days == null ? null : Number(row.num_served_days),
      euTotalReach:
        row.eu_total_reach == null ? null : Number(row.eu_total_reach),
      angle: (row.angle as string | null) ?? null,
      angleUniversal: (row.angle_universal as string | null) ?? null,
      hookArchetype: (row.hook_archetype as string | null) ?? null,
      format: (row.format as string | null) ?? null,
      offerType: (row.offer_type as string | null) ?? null,
      style: (row.style as string | null) ?? null,
      aspectRatio: (row.aspect_ratio as string | null) ?? null,
      fingerprint:
        (row.fingerprint as LabeledEnrichedAd['fingerprint']) ?? null,
      pageName: (row.page_name as string | null) ?? null,
    }));
    return { ads, competitorLastSyncedAt };
  }

  /** Names scrubbed from execution notes at distill time: every tracked
   * competitor/page/advertiser name in the ORG (covers both the tagged and
   * org-wide-fallback ad pools) plus each loaded ad's own page_name. */
  private async loadForbiddenNames(
    organizationId: string,
    ads: LabeledEnrichedAd[],
  ): Promise<string[]> {
    const names = new Set<string>();
    const { data, error } = await this._db
      .from('tracked_competitors')
      .select('name, meta_page_name, google_advertiser_name')
      .eq('organization_id', organizationId);
    if (error) throw error;
    for (const row of data ?? []) {
      for (const value of [
        row.name,
        row.meta_page_name,
        row.google_advertiser_name,
      ]) {
        if (typeof value === 'string' && value.trim().length > 0) {
          names.add(value.trim());
        }
      }
    }
    for (const ad of ads) {
      if (ad.pageName && ad.pageName.trim().length > 0) {
        names.add(ad.pageName.trim());
      }
    }
    return [...names];
  }

  private async loadVectors(
    organizationId: string,
    libraryAdIds: string[],
  ): Promise<AdVector[]> {
    const out: AdVector[] = [];
    for (let i = 0; i < libraryAdIds.length; i += IN_CHUNK) {
      const chunk = libraryAdIds.slice(i, i + IN_CHUNK);
      const { data, error } = await this._db
        .from('ad_embeddings')
        .select('library_ad_id, embedding, embedding_model')
        .eq('organization_id', organizationId)
        .in('library_ad_id', chunk);
      if (error) throw error;
      for (const row of data ?? []) {
        const vector = parseVectorLiteral(row.embedding);
        if (!vector) continue;
        out.push({
          libraryAdId: String(row.library_ad_id),
          vector,
          embeddingModel: String(row.embedding_model),
        });
      }
    }
    return out;
  }
}

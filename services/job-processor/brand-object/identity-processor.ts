/**
 * brand_object_identity — ONE strict-schema LLM call over crawled pages +
 * profile + own ad copy, mechanically verified (every sourced claim's
 * sentence must be an exact substring of a crawled page — unverifiable
 * claims are dropped, never fail the job), reconciled into brand_facts.
 * Gates, in order: monthly budget cap (non-retryable), pack fingerprint +
 * cooldown (an unchanged pack never re-runs the LLM). Stale auto-extracted
 * candidates a fresh run no longer produces are RETIRED (valid_to stamped);
 * confirmed facts are untouched — contradictions surface as suggestions
 * only when they collide on the same fact key.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveConnectedAdAccountScope } from '@/lib/accounts/connected-scope';
import { BRAND_OBJECT_CONFIG } from '@/lib/brand-object/config';
import {
  computeCompleteness,
  deriveStatus,
} from '@/lib/brand-object/completeness';
import {
  buildIdentityPack,
  type CrawledPage,
  type OwnAdCopy,
} from '@/lib/brand-object/identity/pack';
import {
  getBrandObjectIdentityModel,
  IDENTITY_RESPONSE_FORMAT,
  identityResponseSchema,
} from '@/lib/brand-object/identity/prompt';
import { buildIdentityCandidates } from '@/lib/brand-object/identity/verify';
import { reconcileFacts } from '@/lib/brand-object/reconciler';
import type { BrandSection } from '@/lib/brand-object/types';
import { decodeChatJson } from '@/lib/brand-presence/llm';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import { r2Service } from '@/services/r2-service';
import type { Job } from '../types';
import {
  executeReconcilePlan,
  loadLiveFacts,
  loadRejectedKeys,
  retireFacts,
} from './fact-writer';
import { enqueueBrandObjectChunks, enqueueBrandObjectPromote } from './queue';
import {
  assertBrandObjectBudget,
  ensureBrandObjectState,
  mergeBrandObjectState,
  recordBrandObjectUsage,
} from './state';
import { brandObjectIdentityPayloadSchema } from './types';

const R2_BUCKET = 'adcero-ad-creatives';
const IDENTITY_SECTIONS: readonly BrandSection[] = [
  'positioning',
  'value_prop',
  'usp',
  'proof_point',
  'voice',
  'compliance',
];

export class BrandObjectIdentityProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(job: Job, signal: AbortSignal): Promise<void> {
    const payload = brandObjectIdentityPayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, crawlRefs, chain } = payload;
    const label = `[BrandObject] Identity ${brandProfileId}`;
    const cfg = BRAND_OBJECT_CONFIG.identity;

    const state = await ensureBrandObjectState(
      this._db,
      organizationId,
      brandProfileId,
    );

    const profile = await this.loadProfile(organizationId, brandProfileId);
    const pages = await this.loadPages(crawlRefs);
    // Own ad copy = the org's connected-account ads PLUS the brand's own scraped
    // Facebook Page ads (is_brand_self). The scrape is the only own-ad source
    // when the brand's Meta account isn't connected; both feed the same pack.
    const ownAds = [
      ...(await this.loadOwnAdCopy(organizationId, label)),
      ...(await this.loadSelfAdCopy(organizationId, brandProfileId)),
    ].slice(0, BRAND_OBJECT_CONFIG.identity.maxOwnAds);
    const pack = buildIdentityPack(profile, pages, ownAds);

    // Fingerprint + cooldown gate — the LLM never re-reads an unchanged pack.
    const cursor = state.cursors?.identity ?? {};
    const lastRunAt = cursor.lastRunAt ? Date.parse(cursor.lastRunAt) : 0;
    const withinCooldown =
      Date.now() - lastRunAt < cfg.cooldownDays * 24 * 60 * 60 * 1000;
    if (cursor.packFingerprint === pack.fingerprint && withinCooldown) {
      console.log(`${label}: pack unchanged within cooldown — skipping LLM`);
      await this.chainNext(payload, label, chain);
      return;
    }

    assertBrandObjectBudget(state);

    const completion = await openAIChatCompletion({
      body: {
        model: getBrandObjectIdentityModel(),
        messages: [
          { role: 'system', content: pack.system },
          { role: 'user', content: pack.user },
        ],
        response_format: IDENTITY_RESPONSE_FORMAT,
        temperature: 0.2,
        // Queue job, no human waiting → Flex tier (50% off).
        ...flexServiceTier(),
      },
      signal,
      retryProfile: 'background',
    });
    const usage = (
      completion as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }
    ).usage;
    await recordBrandObjectUsage(this._db, organizationId, brandProfileId, {
      llmCalls: 1,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    });

    const response = identityResponseSchema.parse(decodeChatJson(completion));
    const { candidates, droppedCount } = buildIdentityCandidates(
      response,
      pages,
    );

    const liveFacts = await loadLiveFacts(
      this._db,
      organizationId,
      brandProfileId,
      IDENTITY_SECTIONS,
    );
    const rejectedKeys = await loadRejectedKeys(
      this._db,
      organizationId,
      brandProfileId,
      liveFacts,
      IDENTITY_SECTIONS,
    );
    const plan = reconcileFacts({ candidates, liveFacts, rejectedKeys });
    const counts = await executeReconcilePlan(
      this._db,
      organizationId,
      brandProfileId,
      plan,
    );

    // Retire stale auto candidates the fresh extraction no longer produces
    // (identity re-derives whole sections). Confirmed facts never retire.
    const freshKeys = new Set(
      candidates.map((candidate) => `${candidate.section}:${candidate.factKey}`),
    );
    const staleIds = liveFacts
      .filter(
        (fact) =>
          fact.status === 'candidate' &&
          fact.source === 'identity_extraction' &&
          !freshKeys.has(`${fact.section}:${fact.factKey}`),
      )
      .map((fact) => fact.id);
    const retired = await retireFacts(
      this._db,
      organizationId,
      brandProfileId,
      staleIds,
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
        identity: {
          packFingerprint: pack.fingerprint,
          lastRunAt: new Date().toISOString(),
        },
      },
    });

    console.log(
      `${label}: ${counts.inserted} inserted, ${counts.superseded} superseded, ` +
        `${counts.suggested} suggested, ${counts.refreshed} refreshed, ` +
        `${retired} retired, ${droppedCount} unverified dropped ` +
        `(${pack.pageCount} pages, ${ownAds.length} own ads)`,
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
    const promote = await enqueueBrandObjectPromote(this._db, {
      ...scope,
      chain: true,
    });
    console.log(
      `${label}: promote ${promote.deduped ? 'already queued' : 'queued'} (${promote.jobId})`,
    );
  }

  private async loadProfile(organizationId: string, brandProfileId: string) {
    const { data, error } = await this._db
      .from('brand_presence_profiles')
      .select('brand_name, website_url, product_description, category, competitors')
      .eq('organization_id', organizationId)
      .eq('id', brandProfileId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Brand profile ${brandProfileId} not found`);
    return {
      brandName: String(data.brand_name),
      websiteUrl: String(data.website_url),
      productDescription: (data.product_description as string | null) ?? null,
      category: (data.category as string | null) ?? null,
      competitors: Array.isArray(data.competitors)
        ? (data.competitors as string[])
        : [],
    };
  }

  /** Crawled pages from R2 — a missing/corrupt ref degrades to fewer pages,
   * never a dead end (the pack still carries profile + ad copy). */
  private async loadPages(crawlRefs: string[]): Promise<CrawledPage[]> {
    const pages: CrawledPage[] = [];
    for (const ref of crawlRefs) {
      try {
        const body = await r2Service.downloadFile(R2_BUCKET, ref);
        const raw = await (
          body as { transformToString: () => Promise<string> }
        ).transformToString();
        const parsed = JSON.parse(raw) as { url?: string; text?: string };
        if (parsed.url && parsed.text) {
          pages.push({ url: parsed.url, text: parsed.text });
        }
      } catch (error) {
        console.warn(
          `[BrandObject] Identity: unreadable crawl ref ${ref} (skipped)`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return pages;
  }

  /**
   * The org's own synced ad copy — CONNECTED ad accounts only (rule of record:
   * `app/api/CLAUDE.md` → "Disconnected-account entity rows"). A disconnected
   * account's `ads` rows stay in the table but no longer describe the brand's
   * running voice; reconnecting restores them. No connected account → no
   * synced copy (the pack still carries pages + the brand's scraped ads).
   */
  private async loadOwnAdCopy(
    organizationId: string,
    label: string,
  ): Promise<OwnAdCopy[]> {
    const { accountIds } = await resolveConnectedAdAccountScope({
      supabase: this._db,
      organizationId,
    });
    if (accountIds.length === 0) {
      console.log(`${label}: no connected ad accounts, synced own-ad copy skipped`);
      return [];
    }

    const { data, error } = await this._db
      .from('ads')
      .select(
        'ad_id, primary_text_1, primary_text_2, headline_1, headline_2, description_1',
      )
      .eq('organization_id', organizationId)
      .in('ad_account_id', accountIds)
      .limit(BRAND_OBJECT_CONFIG.identity.maxOwnAds);
    if (error) throw error;
    return (data ?? [])
      .map((row) => ({
        adId: String(row.ad_id),
        texts: [
          row.primary_text_1,
          row.primary_text_2,
          row.headline_1,
          row.headline_2,
          row.description_1,
        ].filter((text): text is string => Boolean(text)),
      }))
      .filter((ad) => ad.texts.length > 0);
  }

  /**
   * The brand's OWN scraped Facebook Page ad copy — `tracked_competitors` rows
   * flagged `is_brand_self` for this brand, joined to their `library_ads`. This
   * is first-party identity signal (never competitive market), and the only
   * own-ad source when the brand's Meta account isn't connected to Adcero.
   */
  private async loadSelfAdCopy(
    organizationId: string,
    brandProfileId: string,
  ): Promise<OwnAdCopy[]> {
    const { data: selfRows, error: selfError } = await this._db
      .from('tracked_competitors')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('brand_profile_id', brandProfileId)
      .eq('is_brand_self', true);
    if (selfError) throw selfError;
    const selfIds = (selfRows ?? []).map((row) => String(row.id));
    if (selfIds.length === 0) return [];

    const { data, error } = await this._db
      .from('library_ads')
      .select('id, creative_bodies, creative_link_titles')
      .eq('organization_id', organizationId)
      .in('competitor_id', selfIds)
      .limit(BRAND_OBJECT_CONFIG.identity.maxOwnAds);
    if (error) throw error;
    const asStrings = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
    return (data ?? [])
      .map((row) => ({
        adId: String(row.id),
        texts: [
          ...asStrings(row.creative_bodies),
          ...asStrings(row.creative_link_titles),
        ],
      }))
      .filter((ad) => ad.texts.length > 0);
  }
}

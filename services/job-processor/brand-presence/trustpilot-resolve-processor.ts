import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import {
  deriveTrustpilotDomain,
  normalizeDomain,
  trustpilotUrlFromDomain,
} from '@/lib/brand-presence/trustpilot';
import type {
  SourceMeta,
  TrustpilotPageMeta,
  TrustpilotResolveCheckpoint,
  TrustpilotSourceMeta,
} from '@/lib/brand-presence/types';
import {
  buildProbeInput,
  buildSearchInput,
} from '@/services/brand-presence/trustpilot-actor-input';
import {
  TrustpilotApifyProvider,
  TrustpilotProviderError,
} from '@/services/brand-presence/trustpilot-apify-provider';
import {
  companyMatchesDomain,
  extractCompanyFromItem,
  groupCandidatesByCompany,
  type ExtractedTrustpilotCompany,
} from '@/services/brand-presence/trustpilot-normalizer';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import { awaitRunCompletion } from './run-lifecycle';
import {
  confirmTrustpilotSource,
  recordAutoConfirmedListening,
} from './confirm-source';
import { brandPresenceTrustpilotResolvePayloadSchema } from './types';

interface SourceRow {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_type: string;
  label: string | null;
  meta: SourceMeta | null;
}

/**
 * brand_presence_trustpilot_resolve — the probe→probe_www→search resolution
 * machine. The setup route seeds meta.trustpilot.page.domain (the target
 * slug); this job runs a small enriched probe against it and applies the
 * WRONG-COMPANY gate: a wrong `/review/` slug makes the actor
 * internal-search-fallback, so a non-empty dataset is NOT a confirmation —
 * the returned company domain must match the target (identifying OR
 * referring, both normalized). On a match it writes the confirm-card metadata
 * (meta.trustpilot.page, degraded=false, status pending) keyed on the actor's
 * EXACT unit slug (`www.` preserved — units are keyed by exact string). When
 * the probe fails to verify a bare seed, ONE `www.<seed>` retry probe runs
 * first (units like www.beeinspiredclothing.com are unreachable at the bare
 * slug); only then does it fall back to an autosuggest search
 * (auto-derived-domain path → candidate picker) or write a degraded card
 * (pasted-URL / chosen-candidate path — explicit target, no search loop).
 *
 * Nothing is scraped until the founder confirms (meta.trustpilot.page.confirmedAt,
 * set by the confirm route). Crash-resume state lives in
 * meta.trustpilot.resolve (mode + runId persisted immediately after start so a
 * yielded job resumes the SAME billable run).
 */
export class BrandPresenceTrustpilotResolveProcessor {
  private providerInstance: TrustpilotApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: TrustpilotApifyProvider,
  ) {
    this.providerInstance = provider ?? null;
  }

  private get provider(): TrustpilotApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new TrustpilotApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceTrustpilotResolvePayloadSchema.parse(
      job.payload,
    );
    const { organizationId, brandProfileId, sourceId, allowSearchFallback } =
      payload;
    const label = `[BrandPresence] TrustpilotResolve ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source || source.source_type !== 'trustpilot') {
      console.log(`${label}: source missing, skipping`);
      return;
    }
    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const tp: TrustpilotSourceMeta = { ...(meta.trustpilot ?? {}) };
    meta.trustpilot = tp;

    const seedDomain = tp.page?.domain;
    if (!seedDomain) {
      console.log(`${label}: no target domain on source, skipping`);
      return;
    }
    // Re-resolving a page that was already confirmed for this domain keeps the
    // founder gate closed but preserves the timestamp.
    const priorConfirmedAt = tp.page?.confirmedAt;

    // The mode the NEXT run should use — a checkpoint pins it on resume,
    // otherwise a fresh resolve always starts with the probe.
    let phaseMode: TrustpilotResolveCheckpoint['mode'] =
      tp.resolve?.mode ?? 'probe';

    try {
      for (;;) {
        if (signal.aborted) throw new Error('Brand presence job aborted');

        // Start this mode's run if none is checkpointed. Persist the ids in
        // the very next await — that window is the only unavoidable orphan.
        if (!tp.resolve) {
          const input =
            phaseMode === 'search'
              ? buildSearchInput(
                  await this.resolveSearchTerms(organizationId, brandProfileId),
                )
              : buildProbeInput(
                  phaseMode === 'probe_www' ? `www.${seedDomain}` : seedDomain,
                );
          const handle = await this.provider.startRun(input);
          const nowIso = new Date().toISOString();
          tp.resolve = {
            mode: phaseMode,
            runId: handle.runId,
            datasetId: handle.datasetId,
            runStartedAt: nowIso,
            startedAt: nowIso,
          };
          await this.persistSource(source, meta);
          console.log(
            `${label}: started ${phaseMode} run ${handle.runId}`,
          );
        }

        const resolve = tp.resolve;
        const outcome = await awaitRunCompletion({
          provider: this.provider,
          runId: resolve.runId,
          runStartedAt: resolve.runStartedAt,
          signal,
          timeoutTracker,
          label,
        });
        if (outcome.outcome === 'failed') {
          delete tp.resolve;
          await this.persistSource(source, meta);
          throw new TrustpilotProviderError(
            `Trustpilot resolve run failed (mode=${resolve.mode}${outcome.wedged ? ', wedged' : ''})`,
            { retryable: outcome.retryable },
          );
        }

        if (resolve.mode === 'search') {
          const items = await this.provider.listDatasetItems(
            resolve.datasetId,
            0,
            BRAND_PRESENCE_CONFIG.trustpilot.searchMaxItems,
          );
          const candidates = groupCandidatesByCompany(items).slice(
            0,
            BRAND_PRESENCE_CONFIG.trustpilot.candidateCap,
          );
          tp.candidates = candidates;
          // Reaching search means the probe could NOT verify the page — drop any
          // stale resolved card so the panel shows the picker, not old page data
          // (the ladder checks page before candidates).
          delete tp.page;
          delete tp.resolve;
          delete meta.lastError;
          await this.persistSource(source, meta, { status: 'pending' });
          console.log(
            `${label}: search fallback found ${candidates.length} candidate(s)`,
          );
          return;
        }

        // Probe: verify the returned company block matches the target slug.
        const items = await this.provider.listDatasetItems(
          resolve.datasetId,
          0,
          BRAND_PRESENCE_CONFIG.trustpilot.probeMaxItems,
        );
        const company = items.length > 0 ? extractCompanyFromItem(items[0]) : null;

        if (
          company &&
          company.domain &&
          companyMatchesDomain(company, seedDomain)
        ) {
          const page = this.buildResolvedPage(
            company,
            seedDomain,
            priorConfirmedAt,
          );
          tp.page = page;
          delete tp.resolve;
          delete tp.candidates;
          delete meta.lastError;
          await this.persistSource(source, meta, {
            ...(company.name
              ? { label: `Trustpilot — ${company.name}` }
              : {}),
            status: 'pending',
          });
          console.log(
            `${label}: resolved "${company.name ?? page.domain}" (${page.reviewsCount ?? '?'} reviews)`,
          );

          // Auto-confirm: only a founder-PASTED page URL rides
          // autoConfirm=true (setup gates out derived-domain and picker
          // candidates), and only the wrong-company-verified clean match
          // reaches this branch — that combination is consent. Best-effort,
          // never rethrown (a rethrow would retry into a NEW billable probe
          // run); on failure revert to awaiting-confirm. The enqueued scrape
          // is claimed by the running drain — no kickoff here.
          if (payload.autoConfirm) {
            try {
              const confirmed = await confirmTrustpilotSource(this._db, {
                organizationId,
                brandProfileId,
              });
              await recordAutoConfirmedListening(this._db, payload, 'trustpilot', confirmed);
              console.log(`${label}: auto-confirmed — review scrape queued`);
            } catch (error) {
              console.warn(
                `${label}: auto-confirm failed — awaiting manual confirm`,
                error instanceof Error ? error.message : error,
              );
              await this.persistSource(source, meta, {
                status: 'pending',
              }).catch(() => {});
            }
          }
          return;
        }

        // Zero items OR wrong company. A bare seed gets ONE `www.<seed>` retry
        // probe first — Trustpilot units are keyed by exact string and can
        // live only at the www variant. Gate on the FAILED run's checkpoint
        // mode (not phaseMode) so the ladder terminates structurally: after a
        // failed probe_www run, resolve.mode !== 'probe' and control falls
        // through to search/degraded.
        if (resolve.mode === 'probe' && !seedDomain.startsWith('www.')) {
          phaseMode = 'probe_www';
          delete tp.resolve;
          // No persist/yield here — mirrors the search transition below: the
          // next iteration starts (and persists) the www probe run.
          continue;
        }

        // Auto-derived paths fall back to a brand-name search;
        // explicit-target paths degrade to a manual card.
        if (allowSearchFallback) {
          phaseMode = 'search';
          delete tp.resolve;
          // No persist/yield here — the next iteration starts (and persists)
          // the search run before the next awaitRunCompletion can yield.
          continue;
        }

        const degraded = this.buildDegradedPage(seedDomain, priorConfirmedAt);
        tp.page = degraded;
        delete tp.resolve;
        delete meta.lastError;
        await this.persistSource(source, meta, { status: 'pending' });
        console.log(`${label}: probe unverified -> degraded card`);
        return;
      }
    } catch (error) {
      // Timeouts keep the checkpoint (that is what resume is); real failures
      // clear it, record the error, and surface status=error.
      if (!(error instanceof FunctionTimeoutError)) {
        delete tp.resolve;
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

  private buildResolvedPage(
    company: ExtractedTrustpilotCompany,
    seedDomain: string,
    priorConfirmedAt: string | undefined,
  ): TrustpilotPageMeta {
    // Target the actor's EXACT unit slug (`www.` preserved) — the normalized
    // domain is comparison-only and can point at a different (empty) unit.
    const domain = (company.slug ?? company.domain) as string;
    const starDistribution = company.starDistribution;
    return {
      url: trustpilotUrlFromDomain(domain),
      domain,
      title: company.name,
      trustScore: company.trustScore,
      reviewsCount: company.reviewsCount,
      ...(Object.keys(starDistribution).length > 0 ? { starDistribution } : {}),
      verifiedDomain: company.websiteUrl
        ? deriveTrustpilotDomain(company.websiteUrl)
        : null,
      resolvedAt: new Date().toISOString(),
      degraded: false,
      // Preserve the founder gate only when re-resolving the same unit —
      // normalized compare: a bare seed that verified via the www ladder is
      // still the same unit the founder confirmed.
      ...(priorConfirmedAt &&
      normalizeDomain(domain) === normalizeDomain(seedDomain)
        ? { confirmedAt: priorConfirmedAt }
        : {}),
    };
  }

  private buildDegradedPage(
    seedDomain: string,
    priorConfirmedAt: string | undefined,
  ): TrustpilotPageMeta {
    return {
      url: trustpilotUrlFromDomain(seedDomain),
      domain: seedDomain,
      title: null,
      trustScore: null,
      reviewsCount: null,
      verifiedDomain: null,
      resolvedAt: new Date().toISOString(),
      degraded: true,
      ...(priorConfirmedAt ? { confirmedAt: priorConfirmedAt } : {}),
    };
  }

  /** name_variants (non-empty) drive the autosuggest search; brand_name is the
   * fallback when the profile has no variants. */
  private async resolveSearchTerms(
    organizationId: string,
    brandProfileId: string,
  ): Promise<string[]> {
    const { data, error } = await this._db
      .from('brand_presence_profiles')
      .select('brand_name, name_variants')
      .eq('id', brandProfileId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw error;
    const variants = Array.isArray(data?.name_variants)
      ? (data.name_variants as unknown[]).filter(
          (item): item is string =>
            typeof item === 'string' && item.trim() !== '',
        )
      : [];
    if (variants.length > 0) return variants;
    const brandName =
      typeof data?.brand_name === 'string' ? data.brand_name.trim() : '';
    return brandName ? [brandName] : [];
  }

  private async loadSource(
    organizationId: string,
    brandProfileId: string,
    sourceId: string,
  ): Promise<SourceRow | null> {
    const { data, error } = await this._db
      .from('brand_presence_sources')
      .select('id, organization_id, brand_profile_id, source_type, label, meta')
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

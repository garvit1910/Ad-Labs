import type { SupabaseClient } from '@supabase/supabase-js';
import { parsePlaceNameFromUrl } from '@/lib/brand-presence/google-maps';
import type {
  GooglePlaceMeta,
  SourceMeta,
} from '@/lib/brand-presence/types';
import { buildPlaceResolveInput } from '@/services/brand-presence/google-maps-actor-input';
import {
  GoogleMapsApifyProvider,
  GoogleMapsProviderError,
} from '@/services/brand-presence/google-maps-apify-provider';
import {
  extractPlaceMetaFromItem,
  placeMatchesBrand,
} from '@/services/brand-presence/google-maps-normalizer';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import {
  confirmGoogleMapsSource,
  recordAutoConfirmedListening,
} from './confirm-source';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceGooglePlacePayloadSchema } from './types';

interface SourceRow {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_type: string;
  label: string | null;
  meta: SourceMeta | null;
}

/**
 * brand_presence_google_place — the Phase-1 resolve probe. Runs the SAME
 * reviews actor with maxReviews=1 against the founder-pasted Maps URL: one
 * review item carries the place metadata (title, placeId, address,
 * totalScore, reviewsCount) for the confirmation card. Nothing is scraped
 * until the founder confirms (meta.place.confirmedAt, set by the confirm
 * route). A zero-review listing returns an empty dataset → degraded place
 * from the URL's /maps/place/<name>/ segment.
 *
 * Crash-resume state lives in source.meta.resolve (runId persisted
 * immediately after start so a yielded job polls the same billable run).
 */
export class BrandPresenceGooglePlaceProcessor {
  private providerInstance: GoogleMapsApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: GoogleMapsApifyProvider,
  ) {
    this.providerInstance = provider ?? null;
  }

  private get provider(): GoogleMapsApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new GoogleMapsApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceGooglePlacePayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, sourceId } = payload;
    const label = `[BrandPresence] GooglePlace ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source || source.source_type !== 'google_maps_reviews') {
      console.log(`${label}: source missing, skipping`);
      return;
    }
    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const placeUrl = meta.place?.url;
    if (!placeUrl) {
      console.log(`${label}: no place URL on source, skipping`);
      return;
    }

    try {
      if (!meta.resolve) {
        const handle = await this.provider.startRun(
          buildPlaceResolveInput(placeUrl),
        );
        const nowIso = new Date().toISOString();
        meta.resolve = {
          runId: handle.runId,
          datasetId: handle.datasetId,
          runStartedAt: nowIso,
          startedAt: nowIso,
        };
        // Persist in the very next await — that window is the only
        // unavoidable orphan.
        await this.persistSource(source, meta);
        console.log(`${label}: started resolve run ${handle.runId}`);
      }

      const outcome = await awaitRunCompletion({
        provider: this.provider,
        runId: meta.resolve.runId,
        runStartedAt: meta.resolve.runStartedAt,
        signal,
        timeoutTracker,
        label,
      });
      if (outcome.outcome === 'failed') {
        delete meta.resolve;
        await this.persistSource(source, meta);
        throw new GoogleMapsProviderError(
          `Google Maps resolve run failed${outcome.wedged ? ' (wedged)' : ''}`,
          { retryable: outcome.retryable },
        );
      }

      const items = await this.provider.listDatasetItems(
        meta.resolve.datasetId,
        0,
        1,
      );
      const resolved = items.length > 0 ? extractPlaceMetaFromItem(items[0]) : null;
      const nowIso = new Date().toISOString();
      const place: GooglePlaceMeta = resolved
        ? {
            url: placeUrl,
            placeId: resolved.placeId,
            title: resolved.title,
            address: resolved.address,
            totalScore: resolved.totalScore,
            reviewsCount: resolved.reviewsCount,
            resolvedAt: nowIso,
            degraded: false,
          }
        : {
            // Zero-review listing (or an item without place signal): degrade
            // to the URL-parsed name; the founder still confirms explicitly.
            url: placeUrl,
            placeId: null,
            title: parsePlaceNameFromUrl(placeUrl),
            address: null,
            totalScore: null,
            reviewsCount: items.length === 0 ? 0 : null,
            resolvedAt: nowIso,
            degraded: true,
          };

      // Wrong-business gate: a Maps URL resolves cleanly to WHATEVER listing
      // it points at, and Maps reviews skip the relevance LLM entirely — so a
      // title that doesn't name this brand parks the card on the founder
      // instead of auto-confirming a foreign corpus into VOC.
      const nameVariants = await this.loadNameVariants(
        organizationId,
        brandProfileId,
      );
      const matchesBrand =
        !place.degraded && placeMatchesBrand(place.title, nameVariants);
      if (!place.degraded && !matchesBrand) place.brandMismatch = true;

      delete meta.resolve;
      delete meta.lastError;
      meta.place = place;
      await this.persistSource(source, meta, {
        ...(place.title ? { label: `Google Maps — ${place.title}` } : {}),
        status: 'pending',
      });
      console.log(
        `${label}: resolved "${place.title ?? placeUrl}" (${place.reviewsCount ?? '?'} reviews${place.degraded ? ', degraded' : ''}${place.brandMismatch ? ', BRAND MISMATCH' : ''})`,
      );

      // Auto-confirm: the founder pasted THIS listing URL, so a clean
      // (non-degraded) resolve of it is consent — start the review scrape
      // without the extra confirm click. Degraded resolves AND resolves whose
      // title doesn't name the brand keep the manual gate: the pasted URL is
      // the ONLY ownership signal Maps has, so a typo or a stale clipboard
      // must not silently ingest another business's reviews as this brand's
      // customer voice. Best-effort, never rethrown: the probe succeeded and its
      // checkpoint is gone, so failing the job would retry into a NEW
      // billable probe run — instead revert to the awaiting-confirm state so
      // the manual path takes over. The enqueued scrape is claimed by the
      // running drain (SELF_CONTINUING_JOB_TYPES); no kickoff needed here.
      if (payload.autoConfirm && matchesBrand) {
        try {
          const confirmed = await confirmGoogleMapsSource(this._db, {
            organizationId,
            brandProfileId,
          });
          await recordAutoConfirmedListening(this._db, payload, 'google_maps', confirmed);
          console.log(`${label}: auto-confirmed — review scrape queued`);
        } catch (error) {
          console.warn(
            `${label}: auto-confirm failed — awaiting manual confirm`,
            error instanceof Error ? error.message : error,
          );
          await this.persistSource(source, meta, { status: 'pending' }).catch(
            () => {},
          );
        }
      }
    } catch (error) {
      // Timeouts keep the checkpoint (that is what resume is); real failures
      // clear it, record the error, and surface status=error.
      if (!(error instanceof FunctionTimeoutError)) {
        delete meta.resolve;
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

  /** Name variants for the wrong-business gate (brand_name always included —
   * a profile may carry an empty variants array). */
  private async loadNameVariants(
    organizationId: string,
    brandProfileId: string,
  ): Promise<string[]> {
    const { data, error } = await this._db
      .from('brand_presence_profiles')
      .select('brand_name, name_variants')
      .eq('organization_id', organizationId)
      .eq('id', brandProfileId)
      .maybeSingle();
    if (error) throw error;
    const row = data as {
      brand_name: string | null;
      name_variants: string[] | null;
    } | null;
    return [
      ...(row?.brand_name ? [row.brand_name] : []),
      ...(row?.name_variants ?? []),
    ];
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

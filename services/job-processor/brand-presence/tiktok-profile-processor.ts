import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SourceMeta,
  TikTokProfileCard,
} from '@/lib/brand-presence/types';
import {
  buildProfileProbeInput,
  canonicalTikTokProfileUrl,
} from '@/services/brand-presence/tiktok-actor-input';
import {
  TikTokApifyProvider,
  TikTokProviderError,
} from '@/services/brand-presence/tiktok-apify-provider';
import { classifyProbeOutcome } from '@/services/brand-presence/tiktok-normalizer';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import {
  confirmTikTokSource,
  recordAutoConfirmedListening,
} from './confirm-source';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceTikTokProfilePayloadSchema } from './types';

interface SourceRow {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_type: string;
  label: string | null;
  meta: SourceMeta | null;
}

/**
 * brand_presence_tiktok_profile — the Hop-1 resolve probe. Runs the profile
 * scraper at probeMaxVideos against the setup-normalized username: any video
 * item carries the author card (display name, followers, video count) for
 * the confirmation gate. Nothing scrapes at volume until the founder
 * confirms (meta.tiktok.profile.confirmedAt, set by the confirm route).
 *
 * A private / not-found profile is an EXPLICIT TERMINAL STATE
 * (profile.unavailable + the actor's message), never an error status and
 * never retried — the panel offers "try a different username" (Trustpilot
 * degraded-card precedent). An empty dataset with no error marker (e.g. a
 * zero-video account) degrades to a manual-confirm card instead.
 *
 * Crash-resume state lives in source.meta.tiktok.resolve (runId persisted
 * immediately after start so a yielded job polls the same billable run).
 */
export class BrandPresenceTikTokProfileProcessor {
  private providerInstance: TikTokApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: TikTokApifyProvider,
  ) {
    this.providerInstance = provider ?? null;
  }

  private get provider(): TikTokApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new TikTokApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceTikTokProfilePayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, sourceId } = payload;
    const label = `[BrandPresence] TikTokProfile ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source || source.source_type !== 'tiktok_comments') {
      console.log(`${label}: source missing, skipping`);
      return;
    }
    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const tiktok = { ...(meta.tiktok ?? {}) };
    meta.tiktok = tiktok;
    const username = tiktok.username;
    if (!username) {
      console.log(`${label}: no username on source, skipping`);
      return;
    }

    try {
      if (!tiktok.resolve) {
        const handle = await this.provider.startProfileRun(
          buildProfileProbeInput(username),
        );
        const nowIso = new Date().toISOString();
        tiktok.resolve = {
          runId: handle.runId,
          datasetId: handle.datasetId,
          runStartedAt: nowIso,
          startedAt: nowIso,
        };
        // Persist in the very next await — that window is the only
        // unavoidable orphan.
        await this.persistSource(source, meta);
        console.log(`${label}: started probe run ${handle.runId}`);
      }

      const outcome = await awaitRunCompletion({
        provider: this.provider,
        runId: tiktok.resolve.runId,
        runStartedAt: tiktok.resolve.runStartedAt,
        signal,
        timeoutTracker,
        label,
      });
      if (outcome.outcome === 'failed') {
        // Transport failure ≠ a terminal profile state — clear the dead run
        // and retry per max_attempts.
        delete tiktok.resolve;
        await this.persistSource(source, meta);
        throw new TikTokProviderError(
          `TikTok profile probe run failed${outcome.wedged ? ' (wedged)' : ''}`,
          { retryable: outcome.retryable },
        );
      }

      const items = await this.provider.listDatasetItems(
        tiktok.resolve.datasetId,
        0,
        BRAND_PRESENCE_CONFIG.tiktok.probeMaxVideos,
      );
      const probe = classifyProbeOutcome(items);
      const nowIso = new Date().toISOString();
      const url = canonicalTikTokProfileUrl(username);

      let profile: TikTokProfileCard;
      if (probe.kind === 'resolved') {
        profile = {
          username,
          url,
          displayName: probe.card.displayName,
          followers: probe.card.followers,
          videoCount: probe.card.videoCount,
          resolvedAt: nowIso,
          degraded: false,
        };
      } else if (probe.kind === 'unavailable') {
        // The EXPLICIT terminal state: job succeeds, no retry, no alert —
        // the founder picks a different username via setup.
        profile = {
          username,
          url,
          displayName: null,
          followers: null,
          videoCount: null,
          resolvedAt: nowIso,
          degraded: true,
          unavailable: probe.reason,
          unavailableMessage: probe.message,
        };
      } else {
        // Empty/unclassifiable probe (e.g. a zero-video account): degraded
        // card — the founder may still confirm explicitly (Maps zero-review
        // precedent).
        profile = {
          username,
          url,
          displayName: null,
          followers: null,
          videoCount: null,
          resolvedAt: nowIso,
          degraded: true,
        };
      }

      delete tiktok.resolve;
      delete meta.lastError;
      tiktok.profile = profile;
      await this.persistSource(source, meta, {
        label: `TikTok — @${username}`,
        status: 'pending',
      });
      console.log(
        `${label}: resolved @${username} (${
          profile.unavailable ??
          `${profile.videoCount ?? '?'} videos, ${profile.followers ?? '?'} followers${profile.degraded ? ', degraded' : ''}`
        })`,
      );

      // Auto-confirm: the founder submitted THIS username, so a clean public
      // resolve is consent — start the harvest without the extra confirm
      // click. Unavailable/degraded outcomes keep the manual gate.
      // Best-effort, never rethrown (a rethrow would retry into a NEW
      // billable probe run); on failure revert to awaiting-confirm. The
      // enqueued harvest is claimed by the running drain — no kickoff here.
      if (payload.autoConfirm && probe.kind === 'resolved') {
        try {
          const confirmed = await confirmTikTokSource(this._db, {
            organizationId,
            brandProfileId,
          });
          await recordAutoConfirmedListening(this._db, payload, 'tiktok', confirmed);
          console.log(`${label}: auto-confirmed — comment harvest queued`);
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
        delete tiktok.resolve;
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

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  InstagramProfileCard,
  SourceMeta,
} from '@/lib/brand-presence/types';
import {
  buildProfileProbeInput,
  canonicalInstagramProfileUrl,
} from '@/services/brand-presence/instagram-actor-input';
import {
  InstagramApifyProvider,
  InstagramProviderError,
} from '@/services/brand-presence/instagram-apify-provider';
import { classifyInstagramProbeOutcome } from '@/services/brand-presence/instagram-normalizer';
import { BRAND_PRESENCE_CONFIG } from '@/lib/brand-presence/config';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import {
  confirmInstagramSource,
  recordAutoConfirmedListening,
} from './confirm-source';
import { awaitRunCompletion } from './run-lifecycle';
import { brandPresenceInstagramProfilePayloadSchema } from './types';

interface SourceRow {
  id: string;
  organization_id: string;
  brand_profile_id: string;
  source_type: string;
  label: string | null;
  meta: SourceMeta | null;
}

/**
 * brand_presence_instagram_profile — the resolve probe. Runs the scraper in
 * DETAILS mode against the setup-normalized username: one item is the whole
 * profile card (fullName, followers, postsCount, private flag) for the
 * confirmation gate. Nothing scrapes at volume until the founder confirms
 * (meta.instagram.profile.confirmedAt, set by the confirm route).
 *
 * A private / not-found profile is an EXPLICIT TERMINAL STATE
 * (profile.unavailable + a clear message), never an error status and never
 * retried — the panel offers "try a different username" (TikTok/Trustpilot
 * precedent). Private profiles resolve a full details card with
 * private=true; missing ones return the actor's error-marker item
 * (`error: 'not_found'`, pinned live 2026-07-10). An empty dataset with no
 * classifiable signal degrades to a manual-confirm card instead.
 *
 * Crash-resume state lives in source.meta.instagram.resolve (runId
 * persisted immediately after start so a yielded job polls the same
 * billable run).
 */
export class BrandPresenceInstagramProfileProcessor {
  private providerInstance: InstagramApifyProvider | null;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: InstagramApifyProvider,
  ) {
    this.providerInstance = provider ?? null;
  }

  private get provider(): InstagramApifyProvider {
    if (!this.providerInstance) {
      this.providerInstance = new InstagramApifyProvider();
    }
    return this.providerInstance;
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandPresenceInstagramProfilePayloadSchema.parse(
      job.payload,
    );
    const { organizationId, brandProfileId, sourceId } = payload;
    const label = `[BrandPresence] InstagramProfile ${sourceId}`;

    const source = await this.loadSource(
      organizationId,
      brandProfileId,
      sourceId,
    );
    if (!source || source.source_type !== 'instagram_comments') {
      console.log(`${label}: source missing, skipping`);
      return;
    }
    const meta: SourceMeta = { ...(source.meta ?? {}) };
    const instagram = { ...(meta.instagram ?? {}) };
    meta.instagram = instagram;
    const username = instagram.username;
    if (!username) {
      console.log(`${label}: no username on source, skipping`);
      return;
    }

    try {
      if (!instagram.resolve) {
        const handle = await this.provider.startRun(
          buildProfileProbeInput(username),
        );
        const nowIso = new Date().toISOString();
        instagram.resolve = {
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
        runId: instagram.resolve.runId,
        runStartedAt: instagram.resolve.runStartedAt,
        signal,
        timeoutTracker,
        label,
      });
      if (outcome.outcome === 'failed') {
        // Transport failure ≠ a terminal profile state — clear the dead run
        // and retry per max_attempts.
        delete instagram.resolve;
        await this.persistSource(source, meta);
        throw new InstagramProviderError(
          `Instagram profile probe run failed${outcome.wedged ? ' (wedged)' : ''}`,
          { retryable: outcome.retryable },
        );
      }

      const items = await this.provider.listDatasetItems(
        instagram.resolve.datasetId,
        0,
        Math.max(BRAND_PRESENCE_CONFIG.instagram.probeMaxItems, 5),
      );
      const probe = classifyInstagramProbeOutcome(items);
      const nowIso = new Date().toISOString();
      const url = canonicalInstagramProfileUrl(username);

      let profile: InstagramProfileCard;
      if (probe.kind === 'resolved') {
        profile = {
          username,
          url,
          fullName: probe.card.fullName,
          followers: probe.card.followers,
          postsCount: probe.card.postsCount,
          resolvedAt: nowIso,
          degraded: false,
        };
      } else if (probe.kind === 'unavailable') {
        // The EXPLICIT terminal state: job succeeds, no retry, no alert —
        // the founder picks a different username via setup.
        profile = {
          username,
          url,
          fullName: null,
          followers: null,
          postsCount: null,
          resolvedAt: nowIso,
          degraded: true,
          unavailable: probe.reason,
          unavailableMessage: probe.message,
        };
      } else {
        // Empty/unclassifiable probe: degraded card — the founder may still
        // confirm explicitly (Maps zero-review precedent).
        profile = {
          username,
          url,
          fullName: null,
          followers: null,
          postsCount: null,
          resolvedAt: nowIso,
          degraded: true,
        };
      }

      delete instagram.resolve;
      delete meta.lastError;
      instagram.profile = profile;
      await this.persistSource(source, meta, {
        label: `Instagram — @${username}`,
        status: 'pending',
      });
      console.log(
        `${label}: resolved @${username} (${
          profile.unavailable ??
          `${profile.postsCount ?? '?'} posts, ${profile.followers ?? '?'} followers${profile.degraded ? ', degraded' : ''}`
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
          const confirmed = await confirmInstagramSource(this._db, {
            organizationId,
            brandProfileId,
          });
          await recordAutoConfirmedListening(this._db, payload, 'instagram', confirmed);
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
        delete instagram.resolve;
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

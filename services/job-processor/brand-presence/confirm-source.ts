import type { SupabaseClient } from '@supabase/supabase-js';
// The concrete module, NOT the '@/lib/af' barrel — the barrel re-exports
// with-af-route (which imports next/server) and these cores must load under
// plain tsx (scripts/confirm-brand-presence-sources.ts) and inside the job
// processors.
import { AfError } from '@/lib/af/af-error';
import type { SourceMeta } from '@/lib/brand-presence/types';
import {
  recordListeningStarted,
  SYSTEM_ACTIVITY_ACTOR,
  type ListeningPlatform,
  type UserActivityActor,
} from '@/lib/user-activity/record';
import {
  enqueueGoogleReviews,
  enqueueInstagramComments,
  enqueueTikTokComments,
  enqueueTrustpilotReviews,
} from './queue';

/**
 * The founder-confirm cores for the four two-phase listening sources:
 * stamp `confirmedAt` (idempotent), clear lastError, flip the source row to
 * `running`, and enqueue the billable scrape. Extracted verbatim from the
 * confirm routes so the SAME logic (same AfError codes, same guards) serves
 * three callers: the confirm routes (manual founder click), the resolve
 * processors (auto-confirm on a clean explicit resolve), and the
 * confirm-brand-presence-sources.ts repair script. Callers own org-access
 * checks and any kickoff; the enqueue's `bp_*:<sourceId>` dedupe keys make
 * concurrent manual+auto confirms converge on one scrape job.
 */

export interface ConfirmSourceCommand {
  organizationId: string;
  /** Already validated against the org by the caller. */
  brandProfileId: string;
  refresh?: boolean;
}

export interface ConfirmSourceResult {
  jobId: string;
  deduped: boolean;
  sourceId: string;
  /** True when this call stamped `confirmedAt`, i.e. listening started now;
   * false for a re-confirm or a refresh. Drives the `brand_listening_started`
   * user-activity event (lib/user-activity). */
  firstConfirm: boolean;
}

/**
 * The resolve processors' auto-confirm: record `brand_listening_started` for
 * the user whose setup queued the job (`requestedBy`; absent on jobs queued
 * before it existed, which then read as a system start). A re-confirm is not
 * a start, so nothing is recorded.
 */
export async function recordAutoConfirmedListening(
  supabase: SupabaseClient,
  job: { organizationId: string; brandProfileId: string; requestedBy?: UserActivityActor },
  platform: ListeningPlatform,
  result: ConfirmSourceResult,
): Promise<void> {
  if (!result.firstConfirm) return;
  await recordListeningStarted(supabase, {
    organizationId: job.organizationId,
    brandProfileId: job.brandProfileId,
    actor: job.requestedBy ?? SYSTEM_ACTIVITY_ACTOR,
    platform,
    sourceId: result.sourceId,
    metadata: { autoConfirmed: true },
  });
}

// services must not import from app/ — replica of the shared route helper.
function databaseError(message: string): AfError {
  return new AfError(
    'DATABASE_QUERY_FAILED',
    message,
    'Check database connectivity and try again.',
    500,
  );
}

async function loadSeededSource(
  supabase: SupabaseClient,
  command: ConfirmSourceCommand,
  sourceType: string,
  label: string,
): Promise<{ id: string; meta: SourceMeta } | null> {
  const { data: source, error } = await supabase
    .from('brand_presence_sources')
    .select('id, status, meta')
    .eq('organization_id', command.organizationId)
    .eq('brand_profile_id', command.brandProfileId)
    .eq('source_type', sourceType)
    .eq('uri', '')
    .maybeSingle();
  if (error) {
    throw databaseError(`Failed to load ${label} source: ${error.message}`);
  }
  if (!source) return null;
  return {
    id: String(source.id),
    meta: { ...((source.meta as SourceMeta | null) ?? {}) },
  };
}

async function persistConfirmedMeta(
  supabase: SupabaseClient,
  command: ConfirmSourceCommand,
  sourceId: string,
  meta: SourceMeta,
  label: string,
): Promise<void> {
  const { error } = await supabase
    .from('brand_presence_sources')
    .update({
      meta,
      status: 'running',
      updated_at: new Date().toISOString(),
    })
    .eq('id', sourceId)
    .eq('organization_id', command.organizationId);
  if (error) {
    throw databaseError(`Failed to confirm ${label}: ${error.message}`);
  }
}

export async function confirmGoogleMapsSource(
  supabase: SupabaseClient,
  command: ConfirmSourceCommand,
): Promise<ConfirmSourceResult> {
  const refresh = command.refresh ?? false;
  const source = await loadSeededSource(
    supabase,
    command,
    'google_maps_reviews',
    'Google Maps',
  );
  const meta = source?.meta ?? {};
  if (!source || !meta.place?.resolvedAt) {
    throw new AfError(
      'PLACE_NOT_RESOLVED',
      'There is no resolved Google Maps listing to confirm yet.',
      'Submit your listing URL via google-maps/setup and wait for the confirmation card.',
      409,
    );
  }
  if (refresh && !meta.place.confirmedAt) {
    throw new AfError(
      'PLACE_NOT_CONFIRMED',
      'The listing has not been confirmed, so there is nothing to refresh.',
      'Confirm the listing first (refresh=false).',
      409,
    );
  }

  const firstConfirm = !meta.place.confirmedAt;
  // Idempotent stamp — a re-confirm keeps the original gate time.
  meta.place = {
    ...meta.place,
    confirmedAt: meta.place.confirmedAt ?? new Date().toISOString(),
  };
  delete meta.lastError;
  await persistConfirmedMeta(
    supabase,
    command,
    source.id,
    meta,
    'Google Maps listing',
  );

  const { jobId, deduped } = await enqueueGoogleReviews(supabase, {
    organizationId: command.organizationId,
    brandProfileId: command.brandProfileId,
    sourceId: source.id,
    refresh,
  });
  return { jobId, deduped, sourceId: source.id, firstConfirm };
}

export async function confirmTrustpilotSource(
  supabase: SupabaseClient,
  command: ConfirmSourceCommand,
): Promise<ConfirmSourceResult> {
  const refresh = command.refresh ?? false;
  const source = await loadSeededSource(
    supabase,
    command,
    'trustpilot',
    'Trustpilot',
  );
  const meta = source?.meta ?? {};
  if (!source || !meta.trustpilot?.page?.resolvedAt) {
    throw new AfError(
      'TRUSTPILOT_NOT_RESOLVED',
      'There is no resolved Trustpilot page to confirm yet.',
      'Submit your page via trustpilot/setup and wait for the confirmation card.',
      409,
    );
  }
  if (refresh && !meta.trustpilot.page.confirmedAt) {
    throw new AfError(
      'TRUSTPILOT_NOT_CONFIRMED',
      'The Trustpilot page has not been confirmed, so there is nothing to refresh.',
      'Confirm the page first (refresh=false).',
      409,
    );
  }

  const firstConfirm = !meta.trustpilot.page.confirmedAt;
  // Idempotent stamp — a re-confirm keeps the original gate time — and clear
  // any lingering candidate/dismissal state now that a page is confirmed.
  const trustpilot = { ...meta.trustpilot };
  trustpilot.page = {
    ...trustpilot.page!,
    confirmedAt: trustpilot.page!.confirmedAt ?? new Date().toISOString(),
  };
  delete trustpilot.candidates;
  delete trustpilot.notOnPlatform;
  delete trustpilot.dismissedAt;
  meta.trustpilot = trustpilot;
  delete meta.lastError;
  await persistConfirmedMeta(
    supabase,
    command,
    source.id,
    meta,
    'Trustpilot page',
  );

  const { jobId, deduped } = await enqueueTrustpilotReviews(supabase, {
    organizationId: command.organizationId,
    brandProfileId: command.brandProfileId,
    sourceId: source.id,
    refresh,
  });
  return { jobId, deduped, sourceId: source.id, firstConfirm };
}

export async function confirmTikTokSource(
  supabase: SupabaseClient,
  command: ConfirmSourceCommand,
): Promise<ConfirmSourceResult> {
  const refresh = command.refresh ?? false;
  const source = await loadSeededSource(
    supabase,
    command,
    'tiktok_comments',
    'TikTok',
  );
  const meta = source?.meta ?? {};
  if (!source || !meta.tiktok?.profile?.resolvedAt) {
    throw new AfError(
      'TIKTOK_NOT_RESOLVED',
      'There is no resolved TikTok profile to confirm yet.',
      'Submit your profile via tiktok/setup and wait for the confirmation card.',
      409,
    );
  }
  if (meta.tiktok.profile.unavailable) {
    throw new AfError(
      'TIKTOK_PROFILE_UNAVAILABLE',
      meta.tiktok.profile.unavailable === 'private'
        ? 'That TikTok profile is private, so its comments cannot be read.'
        : 'That TikTok profile could not be found.',
      'Run tiktok/setup with a different (public) username.',
      409,
    );
  }
  if (refresh && !meta.tiktok.profile.confirmedAt) {
    throw new AfError(
      'TIKTOK_NOT_CONFIRMED',
      'The TikTok profile has not been confirmed, so there is nothing to refresh.',
      'Confirm the profile first (refresh=false).',
      409,
    );
  }

  const firstConfirm = !meta.tiktok.profile.confirmedAt;
  // Idempotent stamp — a re-confirm keeps the original gate time.
  const tiktok = { ...meta.tiktok };
  tiktok.profile = {
    ...tiktok.profile!,
    confirmedAt: tiktok.profile!.confirmedAt ?? new Date().toISOString(),
  };
  meta.tiktok = tiktok;
  delete meta.lastError;
  await persistConfirmedMeta(
    supabase,
    command,
    source.id,
    meta,
    'TikTok profile',
  );

  const { jobId, deduped } = await enqueueTikTokComments(supabase, {
    organizationId: command.organizationId,
    brandProfileId: command.brandProfileId,
    sourceId: source.id,
    refresh,
  });
  return { jobId, deduped, sourceId: source.id, firstConfirm };
}

export async function confirmInstagramSource(
  supabase: SupabaseClient,
  command: ConfirmSourceCommand,
): Promise<ConfirmSourceResult> {
  const refresh = command.refresh ?? false;
  const source = await loadSeededSource(
    supabase,
    command,
    'instagram_comments',
    'Instagram',
  );
  const meta = source?.meta ?? {};
  if (!source || !meta.instagram?.profile?.resolvedAt) {
    throw new AfError(
      'INSTAGRAM_NOT_RESOLVED',
      'There is no resolved Instagram profile to confirm yet.',
      'Submit your profile via instagram/setup and wait for the confirmation card.',
      409,
    );
  }
  if (meta.instagram.profile.unavailable) {
    throw new AfError(
      'INSTAGRAM_PROFILE_UNAVAILABLE',
      meta.instagram.profile.unavailable === 'private'
        ? 'That Instagram profile is private, so its posts and comments cannot be read.'
        : 'That Instagram profile could not be found.',
      'Run instagram/setup with a different (public) username.',
      409,
    );
  }
  if (refresh && !meta.instagram.profile.confirmedAt) {
    throw new AfError(
      'INSTAGRAM_NOT_CONFIRMED',
      'The Instagram profile has not been confirmed, so there is nothing to refresh.',
      'Confirm the profile first (refresh=false).',
      409,
    );
  }

  const firstConfirm = !meta.instagram.profile.confirmedAt;
  // Idempotent stamp — a re-confirm keeps the original gate time.
  const instagram = { ...meta.instagram };
  instagram.profile = {
    ...instagram.profile!,
    confirmedAt: instagram.profile!.confirmedAt ?? new Date().toISOString(),
  };
  meta.instagram = instagram;
  delete meta.lastError;
  await persistConfirmedMeta(
    supabase,
    command,
    source.id,
    meta,
    'Instagram profile',
  );

  const { jobId, deduped } = await enqueueInstagramComments(supabase, {
    organizationId: command.organizationId,
    brandProfileId: command.brandProfileId,
    sourceId: source.id,
    refresh,
  });
  return { jobId, deduped, sourceId: source.id, firstConfirm };
}

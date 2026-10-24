/**
 * Awaiting-founder-confirmation derivation for two-phase listening sources.
 *
 * These sources keep `status='pending'` from setup until their billable
 * scrape runs, so the raw status conflates "probe in flight" with "resolved,
 * waiting for the founder". The distinction lives in meta (the
 * trustpilot-notOnPlatform precedent: meta state, never a new DB status):
 * a resolved card without `confirmedAt` is waiting on a human. Pure and
 * client-safe — shared by SourceCard/PresenceSourceTabs, the presence
 * status route, the brand-object status route, and useBrandPresenceSources.
 *
 * Note: setup seeds cards with `resolvedAt: ''` (falsy), so a probe still in
 * flight correctly reads as NOT awaiting.
 */
import type { SourceMeta } from '@/lib/brand-presence/types';

export function getAwaitingConfirm(
  sourceType: string,
  meta: SourceMeta | null | undefined,
): boolean {
  if (!meta) return false;

  if (sourceType === 'google_maps_reviews') {
    const place = meta.place;
    return Boolean(place?.resolvedAt) && !place?.confirmedAt;
  }

  if (sourceType === 'trustpilot') {
    const tp = meta.trustpilot;
    if (!tp || tp.notOnPlatform || tp.dismissedAt) return false;
    const pageAwaiting = Boolean(tp.page?.resolvedAt) && !tp.page?.confirmedAt;
    // A non-empty candidates picker with no resolved page also needs the
    // founder; `[]` means the search ran and found nothing (not awaiting).
    const pickerAwaiting =
      (tp.candidates?.length ?? 0) > 0 && !tp.page?.resolvedAt;
    return pageAwaiting || pickerAwaiting;
  }

  if (sourceType === 'tiktok_comments') {
    const profile = meta.tiktok?.profile;
    return (
      Boolean(profile?.resolvedAt) &&
      !profile?.confirmedAt &&
      !profile?.unavailable
    );
  }

  if (sourceType === 'instagram_comments') {
    const profile = meta.instagram?.profile;
    return (
      Boolean(profile?.resolvedAt) &&
      !profile?.confirmedAt &&
      !profile?.unavailable
    );
  }

  return false;
}

/**
 * A source counts toward "the pipeline is doing something" only when its
 * pending/running status is NOT just the awaiting-confirm parking state —
 * otherwise the "Listening…" indicator (and the build-progress card's
 * listening track) spins forever while actually waiting on the founder.
 */
export function isPipelineActiveSource(source: {
  status: string;
  awaitingConfirm?: boolean;
}): boolean {
  return (
    (source.status === 'pending' || source.status === 'running') &&
    !source.awaitingConfirm
  );
}

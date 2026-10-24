/**
 * Shared "time since" formatter for the Brand Identity surfaces.
 *
 * Extracted verbatim from the inline `relativeTime` in
 * `components/brand-identity/CompetitorList.tsx` (its migration to this helper is
 * a follow-up — do not change that file here). Behavior is byte-identical:
 * 'Never' for a null/absent timestamp, then 'Just now' / '{m}m ago' / '{h}h ago'
 * / '{d}d ago'. Day-granular by design — competitor libraries rescrape on a slow
 * (~2-week) cadence, so nothing finer or calendar-week-framed belongs here.
 */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Monthly scrape cadence for competitor ad syncs.
 *
 * The Meta Apify actor bills per result RETURNED, so re-scraping a competitor
 * that hasn't published anything new is pure waste. The daily fan-out is only
 * the scheduler: every scheduled competitor is due once every 30 days. Yield
 * diagnostics are still recorded so future adaptive policies have evidence,
 * but they no longer shorten or lengthen the merchant's paid cadence.
 *
 * State lives on `tracked_competitors.scores.adlibCadence` (an agentic JSONB
 * slot — no new column). `finalizeSync` recomputes it each run; the daily
 * fan-out (`adlib-daily-sync`) reads `nextDueAt` to decide whether to enqueue.
 *
 * COUPLING: `ADLIB_MONTHLY_CADENCE_DAYS` is the gap between scheduled syncs, so
 * `library_ads_enriched.is_active` uses that gap plus a 2-day buffer (32 days).
 * Changing the cadence means revisiting that view window in the same change.
 */

/** Consecutive zero-new-ad syncs before a competitor is treated as cold. */
export const ADLIB_COLD_AFTER_EMPTY_SYNCS = 2;
/** Days between scheduled competitor syncs. */
export const ADLIB_MONTHLY_CADENCE_DAYS = 30;
/** Compatibility aliases retained for persisted diagnostic tier names. */
export const ADLIB_ACTIVE_CADENCE_DAYS = ADLIB_MONTHLY_CADENCE_DAYS;
export const ADLIB_COLD_CADENCE_DAYS = ADLIB_MONTHLY_CADENCE_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;
type AdlibCadenceDays =
  | typeof ADLIB_ACTIVE_CADENCE_DAYS
  | typeof ADLIB_COLD_CADENCE_DAYS;

export interface AdlibCadenceState {
  /** Consecutive syncs that found zero new ads. */
  consecutiveEmptySyncs: number;
  /** Days until the next scheduled sync (active or cold tier). */
  cadenceDays: AdlibCadenceDays;
  /** ISO timestamp the daily fan-out compares against to decide if a sync is due. */
  nextDueAt: string;
  /** ISO timestamp of the last sync that discovered a new ad (diagnostic). */
  lastNewAdAt: string | null;
}

interface AdlibCadenceObservation {
  /** Ads returned by this sync, including already-known rows. */
  totalAds: number;
  /** Result count at which the competitor is considered high volume. */
  highVolumeThreshold: number;
}

function readPrev(prev: unknown): {
  empties: number;
  lastNewAdAt: string | null;
} {
  const p = (prev ?? {}) as Record<string, unknown>;
  const empties =
    typeof p.consecutiveEmptySyncs === 'number' && p.consecutiveEmptySyncs >= 0
      ? p.consecutiveEmptySyncs
      : 0;
  const lastNewAdAt = typeof p.lastNewAdAt === 'string' ? p.lastNewAdAt : null;
  return { empties, lastNewAdAt };
}

/**
 * Recomputes cadence after a sync. `newAdCount === null` means the yield could
 * not be measured (a count read failed) — we keep the competitor on the active
 * cadence and leave the counters untouched. A high-volume sync still resets the
 * empty counter for diagnostics, but every outcome schedules the same 30-day gap.
 */
export function computeAdlibCadence(
  prev: unknown,
  newAdCount: number | null,
  syncIso: string,
  observation?: AdlibCadenceObservation,
): AdlibCadenceState {
  const { empties, lastNewAdAt } = readPrev(prev);
  const base = Date.parse(syncIso);
  const dueIn = (days: number) =>
    new Date(
      (Number.isFinite(base) ? base : Date.now()) + days * DAY_MS,
    ).toISOString();
  const isHighVolume =
    observation !== undefined &&
    Number.isFinite(observation.totalAds) &&
    Number.isFinite(observation.highVolumeThreshold) &&
    observation.highVolumeThreshold > 0 &&
    observation.totalAds >= observation.highVolumeThreshold;

  if (newAdCount === null) {
    // Unknown yield → stay active, don't corrupt the empty-run counter.
    return {
      consecutiveEmptySyncs: empties,
      cadenceDays: ADLIB_ACTIVE_CADENCE_DAYS,
      nextDueAt: dueIn(ADLIB_ACTIVE_CADENCE_DAYS),
      lastNewAdAt,
    };
  }

  if (newAdCount > 0 || isHighVolume) {
    return {
      consecutiveEmptySyncs: 0,
      cadenceDays: ADLIB_ACTIVE_CADENCE_DAYS,
      nextDueAt: dueIn(ADLIB_ACTIVE_CADENCE_DAYS),
      lastNewAdAt: newAdCount > 0 ? syncIso : lastNewAdAt,
    };
  }

  const consecutiveEmptySyncs = empties + 1;
  const cadenceDays =
    consecutiveEmptySyncs >= ADLIB_COLD_AFTER_EMPTY_SYNCS
      ? ADLIB_COLD_CADENCE_DAYS
      : ADLIB_ACTIVE_CADENCE_DAYS;
  return {
    consecutiveEmptySyncs,
    cadenceDays,
    nextDueAt: dueIn(cadenceDays),
    lastNewAdAt,
  };
}

/**
 * True when a competitor is due for a scrape. `lastSyncedAt` enforces the
 * monthly floor immediately for rows carrying an older, shorter nextDueAt.
 * With no usable persisted dates, the gate fails open to "due".
 */
export function isCompetitorDue(
  scores: unknown,
  nowMs: number = Date.now(),
  lastSyncedAt?: string | null,
): boolean {
  const cadence = (scores as Record<string, unknown> | null | undefined)
    ?.adlibCadence as Record<string, unknown> | undefined;
  const nextDueAt = cadence?.nextDueAt;
  const storedDue =
    typeof nextDueAt === 'string' ? Date.parse(nextDueAt) : Number.NaN;
  const lastSync =
    typeof lastSyncedAt === 'string' ? Date.parse(lastSyncedAt) : Number.NaN;
  const monthlyDue = Number.isFinite(lastSync)
    ? lastSync + ADLIB_MONTHLY_CADENCE_DAYS * DAY_MS
    : Number.NaN;
  const dueCandidates = [storedDue, monthlyDue].filter(Number.isFinite);
  if (dueCandidates.length === 0) return true;
  return Math.max(...dueCandidates) <= nowMs;
}

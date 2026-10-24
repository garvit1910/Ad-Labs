import type { NormalizedAd } from '@/services/ad-library/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A delivery_start advance below this is scraper date jitter, not a relaunch.
 * Relaunches key off delivery_start (platform truth), never first_seen_at
 * (ingestion time).
 */
export const RELAUNCH_MIN_ADVANCE_DAYS = 7;
/** Bounded reach series — one sample per sync at monthly cadence ≈ a year. */
export const REACH_HISTORY_MAX_SAMPLES = 12;
/**
 * Skip a reach sample when the previous one is this fresh — manual re-syncs
 * and cache re-serves inside a day would otherwise stack meaningless points.
 */
export const REACH_HISTORY_MIN_GAP_MS = 24 * 60 * 60 * 1000;

/** The columns the pre-read selects from `library_ads` before the upsert. */
export interface ExistingSignalRow {
  external_ad_id: string;
  delivery_start: string | null;
  delivery_stop: string | null;
  scores: unknown;
}

/** `library_ads.scores.relaunch` — resurrection evidence for a known ad. */
export interface RelaunchScore {
  count: number;
  lastAt: string;
  lastReason: 'start_advance' | 'stop_cleared';
  prevDeliveryStart: string | null;
  prevDeliveryStop: string | null;
}

/** One `library_ads.scores.reachHistory` entry. */
export interface ReachSample {
  at: string;
  reach: number;
}

export interface SignalCaptureUpdate {
  externalAdId: string;
  scores: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function parseRelaunch(value: unknown): RelaunchScore | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.count !== 'number' || !Number.isFinite(record.count)) {
    return null;
  }
  return record as unknown as RelaunchScore;
}

function parseReachHistory(value: unknown): ReachSample[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ReachSample =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as ReachSample).at === 'string' &&
      typeof (entry as ReachSample).reach === 'number' &&
      Number.isFinite((entry as ReachSample).reach)
  );
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Computes per-ad `scores` merges capturing sync-over-sync deltas that the
 * blind upsert would otherwise destroy:
 *
 * - `scores.relaunch` — a known external_ad_id whose delivery_start advanced
 *   (> RELAUNCH_MIN_ADVANCE_DAYS) or whose delivery_stop cleared (observed
 *   stopped, now delivering again) was deliberately brought back — near-proof
 *   the ad worked. Self-limiting: the same sync overwrites the compared
 *   columns, so one relaunch is counted once. Note Google's delivery_stop is
 *   a staleness inference, so stop_cleared is softer evidence there.
 * - `scores.reachHistory` — appends {at, reach} so reach-per-day deltas exist
 *   at all (eu_total_reach is an overwritten snapshot; EU-delivered Meta ads
 *   only). New ads seed their first sample.
 *
 * Pure: caller pre-reads the existing rows BEFORE the upsert and persists the
 * returned merges after it. Returns only ads whose scores actually change,
 * preserving unrelated scores keys.
 */
export function computeSignalCaptureUpdates(
  ads: NormalizedAd[],
  existingByExternalId: Map<string, ExistingSignalRow>,
  nowIso: string
): SignalCaptureUpdate[] {
  const nowMs = Date.parse(nowIso);
  const updates = new Map<string, SignalCaptureUpdate>();

  for (const ad of ads) {
    const existing = existingByExternalId.get(ad.externalAdId);
    const baseScores = asRecord(existing?.scores);
    const nextScores = { ...baseScores };
    let changed = false;

    if (existing) {
      const prevStartMs = parseMs(existing.delivery_start);
      const nextStartMs = parseMs(ad.deliveryStart);
      const startAdvanced =
        prevStartMs !== null &&
        nextStartMs !== null &&
        nextStartMs - prevStartMs > RELAUNCH_MIN_ADVANCE_DAYS * DAY_MS;
      const stopCleared =
        existing.delivery_stop !== null && ad.deliveryStop === null;

      if (startAdvanced || stopCleared) {
        const prior = parseRelaunch(baseScores.relaunch);
        const relaunch: RelaunchScore = {
          count: (prior?.count ?? 0) + 1,
          lastAt: nowIso,
          lastReason: startAdvanced ? 'start_advance' : 'stop_cleared',
          prevDeliveryStart: existing.delivery_start,
          prevDeliveryStop: existing.delivery_stop,
        };
        nextScores.relaunch = relaunch as unknown as Record<string, unknown>;
        changed = true;
      }
    }

    const reach = ad.euTotalReach;
    if (typeof reach === 'number' && Number.isFinite(reach) && reach > 0) {
      const history = parseReachHistory(baseScores.reachHistory);
      const last = history[history.length - 1];
      const lastMs = last ? parseMs(last.at) : null;
      const tooFresh =
        lastMs !== null &&
        Number.isFinite(nowMs) &&
        nowMs - lastMs < REACH_HISTORY_MIN_GAP_MS;
      if (!tooFresh) {
        const appended = [...history, { at: nowIso, reach }];
        nextScores.reachHistory = appended.slice(-REACH_HISTORY_MAX_SAMPLES);
        changed = true;
      }
    }

    if (changed) {
      updates.set(ad.externalAdId, {
        externalAdId: ad.externalAdId,
        scores: nextScores,
      });
    }
  }

  return [...updates.values()];
}

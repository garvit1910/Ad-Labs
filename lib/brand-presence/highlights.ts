import type { MentionTags } from '@/lib/brand-presence/types';

/**
 * Pure highlights ranking — the top negative and top positive brand mentions.
 * No IO. Shared by `POST /api/brand-presence/insights/highlights` (the Pulse
 * Overview module) and the Brand Identity report's competitive-landscape
 * summary, so both rank one scan the same way.
 *
 * The caller bounded-scans the brand-scope mention corpus with DB-side
 * pushdown for the reliable filters (scope/relevance/non-null body/non-null
 * sentiment), then the -0.2/+0.2 thresholds and the most-negative/most-positive
 * ordering are computed here — PostgREST jsonb numeric ordering is fragile
 * enough that ranking the bounded sample in TS is the correctness layer.
 * Sentiment lives at `extraction.sentiment` (the -1..1 numeric written by
 * lib/brand-presence/extract.ts).
 */

/** Row cap for the bounded highlights scan (mirrors `insights/get` SCAN_CAP). */
export const HIGHLIGHTS_SCAN_CAP = 5000;

/** Below this the mention is clearly negative; above +0.2 clearly positive. */
export const NEGATIVE_THRESHOLD = -0.2;
export const POSITIVE_THRESHOLD = 0.2;

/** The columns the highlights scan selects. */
export const HIGHLIGHTS_SCAN_COLUMNS =
  'id, platform, data_type, title, body, url, rating, posted_at, extraction, tags';

export interface ScannedMentionRow {
  id: string;
  platform: string;
  data_type: string;
  title: string | null;
  body: string | null;
  url: string | null;
  rating: number | null;
  posted_at: string | null;
  extraction: { sentiment?: number | null } | null;
  tags: MentionTags | null;
}

export interface HighlightMention {
  id: string;
  platform: string;
  dataType: string;
  title: string | null;
  body: string;
  url: string | null;
  rating: number | null;
  postedAt: string | null;
  sentiment: number;
  gist: string | null;
}

/** A scanned row plus its resolved numeric sentiment — the ranking unit. */
export interface RankableMention {
  mention: HighlightMention;
  sentiment: number;
}

/** Drop rows with no usable body or non-numeric sentiment, then project. */
export function toRankable(rows: ScannedMentionRow[]): RankableMention[] {
  const rankable: RankableMention[] = [];
  for (const row of rows) {
    const body = (row.body ?? '').trim();
    if (!body) continue;
    const sentiment = row.extraction?.sentiment;
    if (typeof sentiment !== 'number' || !Number.isFinite(sentiment)) continue;
    rankable.push({
      sentiment,
      mention: {
        id: String(row.id),
        platform: String(row.platform),
        dataType: String(row.data_type),
        title: row.title ?? null,
        body,
        url: row.url ?? null,
        rating: row.rating == null ? null : Number(row.rating),
        postedAt: row.posted_at ?? null,
        sentiment,
        gist: row.tags?.insight?.gist ?? null,
      },
    });
  }
  return rankable;
}

/** Newest first; nulls sort last. */
export function comparePostedAtDesc(
  a: HighlightMention,
  b: HighlightMention,
): number {
  const at = a.postedAt ? Date.parse(a.postedAt) : NaN;
  const bt = b.postedAt ? Date.parse(b.postedAt) : NaN;
  const aValid = Number.isFinite(at);
  const bValid = Number.isFinite(bt);
  if (aValid && bValid) return bt - at;
  if (aValid) return -1;
  if (bValid) return 1;
  return 0;
}

/**
 * Most-negative-first (≤ -0.2) and most-positive-first (≥ +0.2) lists, each
 * capped at `limit`, `posted_at` desc tie-break. Rows usually arrive
 * newest-first so the stable sort already holds the tie-break; the explicit
 * comparator keeps it correct if the DB order ever changes.
 */
export function rankHighlights(
  rows: ScannedMentionRow[],
  limit: number,
): { negative: HighlightMention[]; positive: HighlightMention[] } {
  const rankable = toRankable(rows);

  const negative = rankable
    .filter((row) => row.sentiment <= NEGATIVE_THRESHOLD)
    .sort(
      (a, b) =>
        a.sentiment - b.sentiment || comparePostedAtDesc(a.mention, b.mention),
    )
    .slice(0, limit)
    .map((row) => row.mention);

  const positive = rankable
    .filter((row) => row.sentiment >= POSITIVE_THRESHOLD)
    .sort(
      (a, b) =>
        b.sentiment - a.sentiment || comparePostedAtDesc(a.mention, b.mention),
    )
    .slice(0, limit)
    .map((row) => row.mention);

  return { negative, positive };
}

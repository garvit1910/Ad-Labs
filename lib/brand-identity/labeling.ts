import type { TrackedCompetitor } from './types';

/**
 * Window after a sync during which still-unlabeled ads count as "labelling in
 * progress". Label batches run as background jobs right after a sync; the window
 * keeps the indicator from spinning forever on ads the LLM legitimately drops
 * (those stay unlabeled until the next sync).
 */
export const LABELING_WINDOW_MS = 15 * 60 * 1000;

/**
 * A competitor is mid-labelling when it has recently-synced ads that aren't all
 * labeled yet. Derived purely from counts the competitors/list route already
 * returns — no job lookup. Drives the green row indicator and the list's live
 * refetch in `useCompetitors`.
 */
export function isCompetitorLabeling(
  competitor: Pick<
    TrackedCompetitor,
    'adCount' | 'labeledCount' | 'last_synced_at'
  >,
  now: number = Date.now()
): boolean {
  if (competitor.adCount <= 0) return false;
  if (competitor.labeledCount >= competitor.adCount) return false;
  if (!competitor.last_synced_at) return false;
  return (
    now - new Date(competitor.last_synced_at).getTime() <= LABELING_WINDOW_MS
  );
}

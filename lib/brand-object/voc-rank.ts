/**
 * The ONE VOC ranking used everywhere. The promotion cap (which facts exist),
 * the completeness top-K (which facts count toward confirmation credit), and
 * the review digest (which facts render above the fold) must all rank
 * identically — otherwise "confirm the visible digest → full credit" breaks.
 * PURE and fully deterministic.
 */
import type { FactMetrics } from './types';

export interface VocRankable {
  metrics?: FactMetrics;
  /** Tiebreak label: theme label for candidates, statement for live facts. */
  rankLabel: string;
}

/** decayedFrequency desc → frequency desc → label asc (total, deterministic). */
export function compareVocRank(a: VocRankable, b: VocRankable): number {
  const decayed =
    (b.metrics?.decayedFrequency ?? 0) - (a.metrics?.decayedFrequency ?? 0);
  if (decayed !== 0) return decayed;
  const freq = (b.metrics?.frequency ?? 0) - (a.metrics?.frequency ?? 0);
  if (freq !== 0) return freq;
  return a.rankLabel.localeCompare(b.rankLabel);
}

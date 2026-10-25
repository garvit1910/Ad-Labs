import type { Decision } from '@/lib/spacetime/bindings/types';
import { parseJson } from './format';
import type { Answers } from './whatif';

// The pinned shopper's frozen capture, written by `npm --prefix sim run sim:pin` to
// sim/demo/pinned-shopper.json (its type is PinnedCapture in sim/src/pin.ts; this is the browser's
// copy of that shape).

type Call = { state_hash: string; state: string; questions: Record<string, object>; answers: Answers };
export type PinnedImpression = {
  round: number;
  tick: number;
  arm_id: string;
  creative_id: string;
  headline: string;
  feed: Call & { our_key: string; tap_raw: number; tap_cal: number; draw: number | null; action: string };
  page: Call & {
    stay_raw: number;
    buy_raw: number;
    stay_cal: number;
    buy_cal: number;
    guard: 0 | 1;
    draw: { stay: number | null; buy: number | null };
    action: string;
    objection: string | null;
  };
};
export type Counterfactual = { tap_cal: number; stay_cal: number; buy_cal: number };
export type PinnedCapture = {
  version: 1;
  run: { run_id: string; seed: number; population: number; config_hash: string; offsets: { tap: number; stay: number; buy: number } };
  shopper: { shopper_id: string; display_name: string; segment_id: string; segment_name: string };
  arm: { arm_id: string; label: string };
  reason: { kind: 'need' | 'wear_out'; before: string; after: string; explained: number | null; confounders: string[] };
  before: PinnedImpression;
  after: PinnedImpression;
  counterfactuals: { reverted: Counterfactual; removed: Counterfactual } | null;
  history: unknown[];
};

// The capture belongs to a run when that run's feed decisions for the shopper, at both captured
// sim days, read exactly the captured states (same cache keys). True for the source run and every
// replay of it; false for any other run, even one with the same ids.
export function pinnedFor(capture: PinnedCapture | null, decisions: readonly Decision[]): PinnedCapture | null {
  if (!capture) return null;
  const hashAt = (tick: number) => {
    const d = decisions.find((x) => x.kind === 'feed' && x.shopperId === capture.shopper.shopper_id && x.tick === tick);
    return d ? parseJson<{ state_hash?: string }>(d.options, {}).state_hash : undefined;
  };
  return hashAt(capture.before.tick) === capture.before.feed.state_hash && hashAt(capture.after.tick) === capture.after.feed.state_hash
    ? capture
    : null;
}

/**
 * Demo-only synthetic own-ad angle mix for Chapter 05 ("How it all lines up").
 *
 * The Brand Identity report for the Nimbus demo orgs is pinned to Magic Spoon
 * (`brand-identity-brand-pin.ts`), a demo brand that is NOT the org's real
 * company — so no ad account is connected and `own_ad_labels` is empty. Both of
 * Chapter 05's right-hand columns gate on labeled own ads
 * (`alignment.ts`: `ownAdsLabeled === 0` → "Your angles" stays empty and
 * "Winning angles" hides its verdicts), so the demo report reads
 * "Ads account not connected yet." / "Competitor analysis not run yet." forever
 * even after competitor analysis has run.
 *
 * This module fabricates the ONE missing input — the brand's own advertised
 * angle mix — so the chapter renders its intended four-state story. It is a
 * presentation aid for the pinned demo orgs ONLY (gated by
 * `isBrandIdentityPinnedToBuiltBrand` at the single call site); it must NEVER be
 * used for a real org, whose empty mix correctly reads as "nothing to compare
 * yet".
 *
 * The mix is DERIVED from the market's own winning angles rather than
 * hardcoded, so the overlap is coherent regardless of the exact industry
 * tokens the distillation produced: the top winning angles are marked as run
 * (→ "A winning angle you run" / "You argue this in N ads"), a signature
 * own-only angle is added (→ "Not a top market pattern"), and the remaining
 * winners are deliberately left unrun (→ "Your ads never make this argument" —
 * the honest gap the chapter exists to surface). Pure and JSON-serializable.
 */
import type { MarketFormulaStep } from './insights';
import { normalizeAngleToken, type OwnAdAngleMix } from './own-angles';

/** Cap the winning angles we reason over — mirrors alignment.ts `MAX_ANGLES`. */
const MAX_DEMO_WINNING_ANGLES = 4;

/**
 * A signature own-only angle the demo brand runs that is NOT a top market
 * pattern — ties to Magic Spoon's stated USP ("childhood-cereal nostalgia")
 * and gives the "Your angles" column its "Not a top market pattern" state.
 */
const SIGNATURE_OWN_ANGLE = 'childhood_nostalgia';
const SIGNATURE_OWN_ANGLE_COUNT = 3;

/** Ad counts for the winning angles the demo brand "runs", highest first. */
const RUN_COUNTS = [6, 4];

/**
 * Synthesize a demo own-ad angle mix from the computed market formula. Returns
 * `null` when there are no winning angles to build against, in which case the
 * caller keeps the real (empty) mix and the columns stay in their honest
 * "nothing to compare yet" state.
 */
export function demoOwnAngleMix(
  market: MarketFormulaStep[],
): OwnAdAngleMix | null {
  const winners = (market.find((step) => step.key === 'angle')?.segments ?? [])
    .slice(0, MAX_DEMO_WINNING_ANGLES);
  if (winners.length === 0) return null;

  const byAngle: Record<string, number> = {};

  // Run the 1st and 3rd winning angle, leaving the 2nd/4th unrun so the winning
  // column still shows a real "your ads never make this argument" gap — the
  // whole point of the chapter. With <3 winners we can only run the top one,
  // which still leaves the runner-up unrun.
  const runIndexes = winners.length >= 3 ? [0, 2] : [0];
  runIndexes.forEach((winnerIndex, i) => {
    const segment = winners[winnerIndex];
    if (!segment) return;
    byAngle[normalizeAngleToken(segment.value)] =
      RUN_COUNTS[i] ?? RUN_COUNTS[RUN_COUNTS.length - 1];
  });

  byAngle[SIGNATURE_OWN_ANGLE] = SIGNATURE_OWN_ANGLE_COUNT;

  const totalLabeledAds = Object.values(byAngle).reduce(
    (sum, count) => sum + count,
    0,
  );

  return { totalLabeledAds, byAngle, byUniversal: {} };
}

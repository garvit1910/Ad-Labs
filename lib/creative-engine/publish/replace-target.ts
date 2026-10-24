/**
 * The contract for "replace this Meta ad" (Optimize → Creative Studio → publish).
 *
 * A Meta creative-fatigue or rejected-ad suggestion links into Creative Studio with the
 * old ad as a refresh target. The new ad publishes into the SAME ad set (always created
 * PAUSED — publish never activates delivery). Before publish, the user chooses in a
 * modal whether the old ad is paused now or kept running; the server re-verifies the
 * target and runs the pause best-effort after the create succeeds.
 *
 * PURE and client-safe (types + two pure helpers, no imports). Meta ids are STRINGS
 * everywhere — never `Number()` an id (root CLAUDE.md).
 */

/** What happens to the old ad once the replacement is created. */
export type ReplaceAdAction = 'pause' | 'keep';

export const REPLACE_AD_ACTIONS: readonly ReplaceAdAction[] = ['pause', 'keep'];

/** The read-only preflight route the publish modal calls. */
export const REPLACE_TARGET_ROUTE = '/api/creative-studio/replace-target';

/**
 * The old ad as Meta reports it right now — the `data.target` of
 * `GET /api/creative-studio/replace-target?organizationId=&adAccountId=&adsetId=&adId=`.
 * The route only answers for an ad in the org's own ad account AND in `adsetId`.
 */
export interface MetaReplaceTarget {
  adId: string;
  name: string | null;
  /** Meta `effective_status` (ACTIVE, PAUSED, DISAPPROVED, WITH_ISSUES, …). */
  effectiveStatus: string | null;
  /** True when Meta reports the ad as delivering (`effective_status === 'ACTIVE'`). */
  delivering: boolean;
  adsetId: string;
  /** OTHER ads in the same ad set that are delivering, excluding this one. */
  liveSiblingAds: number;
}

/** Pausing it now would leave the ad set with nothing delivering. */
export function pauseLeavesAdSetDark(target: MetaReplaceTarget): boolean {
  return target.delivering && target.liveSiblingAds === 0;
}

/**
 * The modal's preselected choice: pause when that costs no delivery (other ads still
 * live, or the old ad is not delivering anyway — e.g. rejected); keep it running when it
 * is the ad set's only live ad, so the swap never silently darkens the ad set.
 */
export function defaultReplaceAction(target: MetaReplaceTarget): ReplaceAdAction {
  return pauseLeavesAdSetDark(target) ? 'keep' : 'pause';
}

/**
 * Publish request additions (Meta only): `replaceAdId` (string, ≤64) and
 * `replaceAdAction` (required whenever `replaceAdId` is sent).
 *
 * `MetaCandidatePublishInfo` additions: `replacedAdId`, `replaceAdAction`,
 * `replacePaused` (the pause call succeeded), `replacePauseFailed` (it was requested and
 * failed: the new ad exists, the old ad is still in its previous state).
 *
 * Brief provenance (`creative_briefs.tags.refreshContext`, briefs route):
 * `{ source: 'meta_creative_refresh', replaceAdId }` beside Google's
 * `{ source: 'refresh_low_asset', … }`.
 */
export interface MetaReplaceRequestFields {
  replaceAdId?: string;
  replaceAdAction?: ReplaceAdAction;
}

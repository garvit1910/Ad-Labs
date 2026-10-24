/**
 * Ad Lab same-path stub (REUSE_MANIFEST §8.2): the signal overview is always on.
 * The copied competitor-analysis page no longer asks (its classic branch is
 * deleted, §8.3); kept so the cut point stays filled.
 */
export function isSignalOverviewEnabledForOrg(_identity: {
  organizationId?: string | null;
  organizationName?: string | null;
}): boolean {
  return true;
}

/** Ad Lab same-path stub (REUSE_MANIFEST §8.2): the brand report is always on. */
export function isBrandReportEnabledForOrg(_identity: {
  organizationId?: string | null;
  organizationName?: string | null;
  featureGrants?: readonly string[] | null;
}): boolean {
  return true;
}

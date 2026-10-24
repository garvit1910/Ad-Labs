'use client';

import { useOrganization } from '@/contexts/OrganizationContext';
import { usePlanFeatureUnlocked } from '@/hooks/billing/use-plan-feature';
import { isBrandReportEnabledForOrg } from '@/lib/brand-object/brand-report-access';

/**
 * Whether the current org may use the Brand Identity report side (and so the
 * gated `/api/brand-object/*` + `/api/brand-presence/*` reads). `false` while
 * the org is still resolving. See `lib/brand-object/brand-report-access.ts`.
 */
export function useBrandReportEnabled(): boolean {
  const { currentOrganization } = useOrganization();
  // A trial/paid plan (billing enforcement on) unlocks the report side too.
  const planUnlocked = usePlanFeatureUnlocked('brand_identity');
  return (
    !!currentOrganization &&
    (isBrandReportEnabledForOrg({
      organizationId: currentOrganization.id,
      organizationName: currentOrganization.name,
      featureGrants: currentOrganization.feature_grants,
    }) ||
      planUnlocked)
  );
}

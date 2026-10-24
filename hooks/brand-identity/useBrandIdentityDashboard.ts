'use client';

import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import type { BrandIdentityDashboard } from '@/lib/brand-identity/types';
import { brandIdentityRequest } from '@/lib/services/brand-identity';

export type DashboardPlatform = 'meta' | 'google' | 'all';

/**
 * Win-score dashboard for the Brand Identity landing page. Pass a competitorId
 * to scope the whole dashboard to one competitor; omit it for the
 * all-competitors aggregate. `platform` filters ads by platform ('all' shows
 * both). The query key includes the full scope so switching competitor or
 * platform re-queries cleanly.
 */
export function useBrandIdentityDashboard(
  competitorId?: string,
  platform: DashboardPlatform = 'all'
) {
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useQuery({
    queryKey: [
      'brand-identity',
      'dashboard',
      organizationId,
      competitorId ?? 'all',
      platform,
    ],
    queryFn: () =>
      brandIdentityRequest<BrandIdentityDashboard>('dashboard', {
        organizationId,
        ...(competitorId ? { competitorId } : {}),
        platform,
      }),
    enabled: !!organizationId,
    staleTime: 1000 * 60,
    // Keep the prior scope's data visible while a new platform/competitor loads
    // so the stat cards count-animate old→new instead of flashing skeletons.
    // Drop the placeholder on org switch (organizationId is queryKey[2]) so one
    // org's numbers never animate into another's.
    placeholderData: (previousData, previousQuery) =>
      previousQuery && previousQuery.queryKey[2] !== organizationId
        ? undefined
        : previousData,
  });
}

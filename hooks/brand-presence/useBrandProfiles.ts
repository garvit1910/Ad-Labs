'use client';

import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useBrandReportEnabled } from '@/hooks/brand-object/useBrandReportEnabled';
import type { BrandPresenceProfile } from '@/lib/brand-presence/types';
import { brandPresenceRequest } from '@/lib/services/brand-presence';

export interface BrandProfilesResponse {
  profiles: BrandPresenceProfile[];
  /** brandProfileId -> kept mention count, for the switcher/overview stats. */
  keptCounts: Record<string, number>;
}

export const brandProfilesKey = (organizationId: string | undefined) =>
  ['brand-presence', 'profiles', organizationId] as const;

/**
 * All brand profiles for the current org (agency portfolio). Feeds the brand
 * switcher, the overview grid, and `useBrandProfileScope`. Kept in its own
 * file so the scope hook can depend on it without a cycle through
 * useBrandPresence.
 *
 * Disabled for orgs off the Brand Presence allowlist: `profiles/list` 404s for
 * them, and this read is mounted on pages every org can reach (Competitor
 * Analysis nav, CompetitorList, the add-competitor flows). Disabled resolves
 * to no data + `isLoading: false`, so consumers see an empty, ready scope.
 */
export function useBrandProfiles() {
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;
  const reportEnabled = useBrandReportEnabled();
  return useQuery({
    queryKey: brandProfilesKey(organizationId),
    queryFn: () =>
      brandPresenceRequest<BrandProfilesResponse>('profiles/list', {
        organizationId,
      }),
    enabled: !!organizationId && reportEnabled,
    staleTime: 1000 * 30,
  });
}

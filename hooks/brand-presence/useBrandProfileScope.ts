'use client';

import { useMemo } from 'react';
import { useOrganization } from '@/contexts/OrganizationContext';
import type { BrandPresenceProfile } from '@/lib/brand-presence/types';
import { useBrandProfileStore } from '@/stores/brandProfileStore';
import { useBrandProfiles } from './useBrandProfiles';

export interface BrandProfileScope {
  organizationId: string | undefined;
  profiles: BrandPresenceProfile[];
  /** The resolved active brand id (explicit selection, else newest), or null. */
  selectedProfileId: string | undefined;
  selectedProfile: BrandPresenceProfile | null;
  /** Profiles have loaded and (if any exist) one is resolved. */
  isReady: boolean;
  isLoading: boolean;
}

/**
 * Pure resolution of the active brand from the org's profile list + the
 * persisted explicit selection. Explicit selection wins IF it still exists in
 * the list (so a removed brand's stale id falls back); otherwise the
 * most-recently-updated profile is the default. `profiles` is assumed ordered
 * newest-first (the profiles/list route orders by updated_at desc).
 */
export function deriveBrandProfileScope(params: {
  organizationId: string | undefined;
  profiles: BrandPresenceProfile[];
  explicitSelections: Record<string, string>;
}): { selectedProfileId: string | undefined; selectedProfile: BrandPresenceProfile | null } {
  const { organizationId, profiles, explicitSelections } = params;
  if (!organizationId || profiles.length === 0) {
    return { selectedProfileId: undefined, selectedProfile: null };
  }
  const explicitId = explicitSelections[organizationId];
  const explicit = explicitId
    ? profiles.find((profile) => profile.id === explicitId)
    : undefined;
  const resolved = explicit ?? profiles[0];
  return { selectedProfileId: resolved.id, selectedProfile: resolved };
}

/** Hook wrapper: the active brand for the current org, with loading/ready. */
export function useBrandProfileScope(): BrandProfileScope {
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;
  const { data, isLoading } = useBrandProfiles();
  const explicitSelections = useBrandProfileStore(
    (state) => state.explicitSelections,
  );

  const profiles = useMemo(() => data?.profiles ?? [], [data?.profiles]);

  return useMemo(() => {
    const { selectedProfileId, selectedProfile } = deriveBrandProfileScope({
      organizationId,
      profiles,
      explicitSelections,
    });
    return {
      organizationId,
      profiles,
      selectedProfileId,
      selectedProfile,
      isLoading,
      // Ready once profiles have loaded; if any exist, one is resolved.
      isReady: !isLoading && (profiles.length === 0 || !!selectedProfileId),
    };
  }, [organizationId, profiles, explicitSelections, isLoading]);
}

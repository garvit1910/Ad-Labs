'use client';

/**
 * Ad Lab same-path stub (REUSE_MANIFEST §8.2): one fixed organization.
 * `app/providers.tsx` renders the provider; `useOrganization()` falls back to
 * the same value outside it.
 */
import { createContext, useContext } from 'react';
import { ADLAB_ORG_ID, ADLAB_ORG_NAME } from '@/lib/adlab/org';

export interface Organization {
  id: string;
  name: string;
  feature_grants?: string[];
}

export interface OrganizationContextValue {
  currentOrganization: Organization | null;
  selectedPlatform: string;
}

export const ORG_STUB: OrganizationContextValue = {
  currentOrganization: { id: ADLAB_ORG_ID, name: ADLAB_ORG_NAME, feature_grants: ['brand_presence'] },
  selectedPlatform: 'meta',
};

export const OrganizationContext = createContext<OrganizationContextValue | undefined>(undefined);

export function useOrganization(): OrganizationContextValue {
  return useContext(OrganizationContext) ?? ORG_STUB;
}

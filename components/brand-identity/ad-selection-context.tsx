'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { EnrichedAd } from '@/lib/brand-identity/types';

/**
 * Ad-selection sink for the dashboard panel tree. The page owns the selected
 * ad + the single lifted AdDetailSheet; the panels several levels down only
 * need "open this ad" - providing it via context keeps the callback from
 * drilling through BrandIdentityDashboard/IndustryExplorer/DashboardPanels
 * (the section's one >2-level prop chain).
 */
/**
 * Opens an ad in the detail sheet. An optional `list` (win-score-ranked) makes
 * the sheet navigable - the matrix passes a tactic's full example set so the
 * user can arrow through every ad; grids pass a single ad (no list → no arrows).
 */
export type SelectAd = (_ad: EnrichedAd, _list?: EnrichedAd[]) => void;

const AdSelectionContext = createContext<SelectAd | null>(null);

export function AdSelectionProvider({
  onSelect,
  children,
}: {
  onSelect: SelectAd;
  children: ReactNode;
}) {
  return (
    <AdSelectionContext.Provider value={onSelect}>
      {children}
    </AdSelectionContext.Provider>
  );
}

/** The page-level "open this ad in the detail sheet" callback. */
export function useAdSelection(): SelectAd {
  const onSelect = useContext(AdSelectionContext);
  if (!onSelect) {
    throw new Error('useAdSelection must be used within an AdSelectionProvider');
  }
  return onSelect;
}

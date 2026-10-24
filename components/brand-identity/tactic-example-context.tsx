'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { EnrichedAd } from '@/lib/brand-identity/types';

/**
 * Wiring for the performance-matrix "click a tactic label → open its top ad".
 * The server names each over-index row's `topAdId` (the top-win-score ad
 * carrying that label, chosen over the FULL ad set) and returns the deduped
 * ads as `exampleAds`. The matrix resolves a clicked tactic's `topAdId` here.
 *
 * The example-ad pool + the page's open-ad callback are only known where the
 * dashboard data is loaded (DashboardPanels), so - mirroring AdSelectionProvider
 * - they're provided via context instead of drilled down through
 * WinnersVsRestPanel → DimensionView → PerformanceMatrix.
 */

export interface TacticExampleControls {
  /** Deduped example ads by id - the `exampleAds` pool keyed for O(1) resolution. */
  adById: Map<string, EnrichedAd>;
  /**
   * Opens a tactic's ranked example ads in the page's navigable detail sheet
   * (the AdSelectionProvider sink); the first ad shows, the rest are arrow-through.
   */
  openAds: (_ads: EnrichedAd[]) => void;
}

/** Builds the id → ad map from a dashboard's `exampleAds` pool. */
export function buildAdById(exampleAds: EnrichedAd[]): Map<string, EnrichedAd> {
  return new Map(exampleAds.map((ad) => [ad.id, ad]));
}

const TacticExampleContext = createContext<TacticExampleControls | null>(null);

export function TacticExampleProvider({
  value,
  children,
}: {
  value: TacticExampleControls;
  children: ReactNode;
}) {
  return (
    <TacticExampleContext.Provider value={value}>
      {children}
    </TacticExampleContext.Provider>
  );
}

/**
 * The matrix's "open this tactic's example ads" controls, or null when no provider is
 * mounted (labels then render non-interactive - e.g. the panel rendered in
 * isolation by tests).
 */
export function useTacticExample(): TacticExampleControls | null {
  return useContext(TacticExampleContext);
}

'use client';

import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { AdDetailSheet } from '@/components/brand-identity/AdDetailSheet';
import { AdSelectionProvider } from '@/components/brand-identity/ad-selection-context';
import { useCompetitorFilterSlot } from '@/components/brand-identity/competitor-filter-slot';
import { DashboardCompetitorSelector } from '@/components/brand-identity/DashboardCompetitorSelector';
import { DashboardPlatformSelector } from '@/components/brand-identity/DashboardPlatformSelector';
import { SignalOverview } from '@/components/brand-identity/signal/SignalOverview';
import type { DashboardPlatform } from '@/hooks/brand-identity/useBrandIdentityDashboard';
import { useCompetitors } from '@/hooks/brand-identity/useCompetitors';
import { computeScopedStats } from '@/lib/brand-identity/dashboard';
import type { EnrichedAd } from '@/lib/brand-identity/types';

export default function CompetitorAnalysisOverviewPage() {
  const [selectedAd, setSelectedAd] = useState<EnrichedAd | null>(null);
  // Optional ranked list the selected ad belongs to (matrix tactic click) - the
  // detail sheet arrows through it. Null for single-ad (grid) selections.
  const [selectedAdList, setSelectedAdList] = useState<EnrichedAd[] | null>(null);
  const handleSelectAd = useCallback((ad: EnrichedAd, list?: EnrichedAd[]) => {
    setSelectedAd(ad);
    setSelectedAdList(list ?? null);
  }, []);
  // undefined = all-competitors aggregate; the dropdown narrows to one.
  const [competitorId, setCompetitorId] = useState<string | undefined>(
    undefined,
  );
  const [platform, setPlatform] = useState<DashboardPlatform>('all');

  const { data: competitors, isLoading } = useCompetitors();

  // The scope filters render onto the section tab row (owned by the layout) via
  // this slot, so they sit on the same row as the Overview tabs. Falls back to
  // an inline row before the slot mounts.
  const filterSlot = useCompetitorFilterSlot();
  const scopeFilters = (
    <>
      <DashboardPlatformSelector value={platform} onChange={setPlatform} />
      <DashboardCompetitorSelector
        competitors={competitors ?? []}
        value={competitorId}
        onChange={setCompetitorId}
      />
    </>
  );

  // Ad Lab: the Signal overview is the only competitor overview; Adcero's
  // classic MetricCards + BrandIdentityDashboard branch is cut (REUSE_MANIFEST §8.3).

  // The stats are summed client-side from the (cached) competitor list, so a
  // platform/competitor switch updates them instantly - no dashboard refetch.
  const stats = computeScopedStats(competitors ?? [], { competitorId, platform });
  const labeledPct =
    stats.totalAds > 0
      ? Math.round((stats.labeledAds / stats.totalAds) * 100)
      : 0;
  // Org-wide onboarding gate - independent of the platform/competitor filter so
  // filtering to a scope with no ads shows the dashboard's own empty panel.
  const hasNoCompetitors =
    competitors !== undefined && competitors.length === 0;

  return (
    <AdSelectionProvider onSelect={handleSelectAd}>
      <div className="flex flex-1 flex-col gap-6">
        {/* Competitor scope filters - platform + which tracked competitor.
            Portaled onto the layout's tab row so they share the Overview row;
            inline fallback until the slot mounts. */}
        {filterSlot ? (
          createPortal(scopeFilters, filterSlot)
        ) : (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {scopeFilters}
          </div>
        )}

        <SignalOverview
          stats={stats}
          labeledPct={labeledPct}
          competitors={competitors ?? []}
          competitorId={competitorId}
          platform={platform}
          isLoading={isLoading}
          hasNoCompetitors={hasNoCompetitors}
        />

        <AdDetailSheet
          ad={selectedAd}
          ads={selectedAdList ?? undefined}
          open={selectedAd !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedAd(null);
              setSelectedAdList(null);
            }
          }}
        />
      </div>
    </AdSelectionProvider>
  );
}

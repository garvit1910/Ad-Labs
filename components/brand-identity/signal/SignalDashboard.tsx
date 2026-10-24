'use client';

import { useMemo } from 'react';
import { Layers, Radar, Trophy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useBrandIdentityDashboard,
  type DashboardPlatform,
} from '@/hooks/brand-identity/useBrandIdentityDashboard';
import type { EnrichedAd } from '@/lib/brand-identity/types';
import { useAdSelection } from '../ad-selection-context';
import {
  QueryErrorState,
  RefreshingOverlay,
  RefreshingPill,
  SectionHeader,
} from '../dashboard-shared';
import { DimensionPerformancePanel } from '../DynamicPanels';
import { FullLeaderboardDialog } from '../FullLeaderboardDialog';
import { WinnersVsRestPanel } from '../WinnersVsRestPanel';
import { buildAdById, TacticExampleProvider } from '../tactic-example-context';
import { SignalAngles } from './SignalAngles';
import { SignalTopCreatives } from './SignalTopCreatives';

/**
 * The Signal variant of the win-score analysis stack. Same data as the classic
 * `BrandIdentityDashboard` (`useBrandIdentityDashboard`, same scope, same
 * loading/error/empty handling), restyled: a hero-plus-supporting winners
 * section, momentum-bar angles, the existing Winners-vs-the-rest matrix (reused
 * unchanged), and the dimension-performance bars over the same facets - rendered
 * `flat` here, since the Signal composition carries no card backgrounds.
 */
export function SignalDashboard({
  competitorId,
  platform,
}: {
  competitorId: string | undefined;
  platform: DashboardPlatform;
}) {
  const { data, isLoading, isFetching, isError, refetch } =
    useBrandIdentityDashboard(competitorId, platform);
  const onSelectAd = useAdSelection();
  const t = useTranslations('BrandIdentity.dashboard');
  const tAngles = useTranslations('BrandIdentity.signal.angles');
  const refreshing = isFetching && !isLoading;

  // Provide the matrix-label → example-ads sink (same wiring as DashboardPanels)
  // unconditionally so hook order stays stable across the early returns below.
  const tacticExample = useMemo(
    () => ({
      adById: buildAdById(data?.exampleAds ?? []),
      openAds: (ads: EnrichedAd[]) => ads.length > 0 && onSelectAd(ads[0], ads),
    }),
    [data?.exampleAds, onSelectAd]
  );

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <SectionHeader
        icon={<Trophy className="h-5 w-5" />}
        title={t('topWinningCreatives')}
      />
      {refreshing && <RefreshingPill />}
    </div>
  );

  if (isError && !data) {
    return (
      <div className="space-y-6">
        {header}
        <QueryErrorState
          title={t('loadError')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        {header}
        <Skeleton className="h-64 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (data.scope.totalAds === 0) {
    return (
      <div className="space-y-6">
        {header}
        <div className="flex items-center gap-3 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          <Radar className="h-5 w-5" />
          {t('emptyScope')}
        </div>
      </div>
    );
  }

  const showCompetitor = competitorId === undefined;

  return (
    <div className="relative">
      {refreshing && <RefreshingOverlay />}
      <div
        className={cn(
          'space-y-8 transition-opacity duration-200',
          refreshing && 'pointer-events-none opacity-50'
        )}
      >
        <section className="space-y-4">
          {header}
          <SignalTopCreatives winners={data.winners} onSelectAd={onSelectAd} />
          <FullLeaderboardDialog winners={data.winners} onSelectAd={onSelectAd} />
        </section>

        <section className="space-y-3">
          <SectionHeader
            icon={<Layers className="h-5 w-5" />}
            title={tAngles('title')}
          />
          <SignalAngles
            clusters={data.angleClusters}
            showCompetitor={showCompetitor}
            onSelectAd={onSelectAd}
          />
        </section>

        <TacticExampleProvider value={tacticExample}>
          <WinnersVsRestPanel
            overIndex={data.overIndex}
            labeledAds={data.scope.labeledAds}
            totalAds={data.scope.totalAds}
            mediaQuadrants={data.mediaQuadrants}
            colorScheme="category"
          />
        </TacticExampleProvider>

        <DimensionPerformancePanel
          breakdowns={data.breakdowns}
          mediaQuadrants={data.mediaQuadrants}
          surface="flat"
        />
      </div>
    </div>
  );
}

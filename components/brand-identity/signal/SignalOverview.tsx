'use client';

import type { ComponentProps } from 'react';
import type { DashboardPlatform } from '@/hooks/brand-identity/useBrandIdentityDashboard';
import type { ScopedStats } from '@/lib/brand-identity/dashboard';
import { BrandIdentityEmptyState } from '../BrandIdentityEmptyState';
import { CompetitorSyncHint } from '../CompetitorSyncHint';
import { SignalDashboard } from './SignalDashboard';
import { SignalStatBand } from './SignalStatBand';

/**
 * The Signal competitor-analysis overview - the Nimbus-gated restyle of the
 * classic overview (see `competitor-signal-overview-access.ts`). Renders in
 * place of the classic MetricCards + BrandIdentityDashboard: a monochrome stat
 * band, then the Signal dashboard (hero winners, momentum-bar angles, the
 * Winners-vs-the-rest matrix). The classic IA and every other surface are
 * unchanged; this only swaps the Overview content for gated orgs.
 */
export function SignalOverview({
  stats,
  labeledPct,
  competitors,
  competitorId,
  platform,
  isLoading,
  hasNoCompetitors,
}: {
  stats: ScopedStats;
  labeledPct: number;
  competitors: ComponentProps<typeof CompetitorSyncHint>['competitors'];
  competitorId: string | undefined;
  platform: DashboardPlatform;
  isLoading: boolean;
  hasNoCompetitors: boolean;
}) {
  return (
    <>
      <CompetitorSyncHint competitors={competitors} />
      <SignalStatBand stats={stats} labeledPct={labeledPct} isLoading={isLoading} />
      {!isLoading && hasNoCompetitors ? (
        <BrandIdentityEmptyState />
      ) : (
        <SignalDashboard competitorId={competitorId} platform={platform} />
      )}
    </>
  );
}

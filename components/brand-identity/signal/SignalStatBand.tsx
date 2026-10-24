'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormatLocale } from '@/hooks/useFormatLocale';
import { useBrandIdentityNumbers } from '../dashboard-shared';
import type { ScopedStats } from '@/lib/brand-identity/dashboard';

/**
 * Signal overview stat band. The classic overview's five colored MetricCards
 * flattened into one monochrome row of numbers - only the proven-winners count
 * (Active 60+ days) carries the brand accent, so the one figure that matters
 * reads at a glance. Driven by the same `computeScopedStats` numbers as the
 * classic cards, so it stays in sync with the scope without a dashboard fetch.
 */
export function SignalStatBand({
  stats,
  labeledPct,
  isLoading,
}: {
  stats: ScopedStats;
  labeledPct: number;
  isLoading: boolean;
}) {
  const t = useTranslations('BrandIdentity.signal.stats');
  const formatLocale = useFormatLocale();
  const { pct } = useBrandIdentityNumbers();
  const items: Array<{ key: string; label: string; value: string; hot?: boolean }> = [
    { key: 'tracked', label: t('trackedPages'), value: stats.competitorsTracked.toLocaleString(formatLocale) },
    { key: 'ads', label: t('adsCollected'), value: stats.totalAds.toLocaleString(formatLocale) },
    { key: 'labeled', label: t('aiLabeled'), value: pct(labeledPct / 100) },
    { key: 'active', label: t('stillDelivering'), value: stats.activeAds.toLocaleString(formatLocale) },
    {
      key: 'proven',
      label: t('active60Days'),
      value: stats.provenWinners.toLocaleString(formatLocale),
      hot: true,
    },
  ];

  return (
    <div className="flex flex-wrap gap-x-8 gap-y-4 border-y border-border py-4">
      {items.map((item) => (
        <div key={item.key} className="flex min-w-[84px] flex-col">
          {isLoading ? (
            <Skeleton className="h-7 w-12" />
          ) : (
            <span
              className={`text-2xl font-semibold tracking-tight tabular-nums ${
                item.hot ? 'text-brand-primary' : 'text-foreground'
              }`}
            >
              {item.value}
            </span>
          )}
          <span className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

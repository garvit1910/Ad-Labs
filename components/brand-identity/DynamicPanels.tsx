'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

// Recharts is the section's heaviest client dependency and these are the only
// panels that import it. Loading them via next/dynamic keeps recharts out of
// the overview's first-paint bundle (mirrors app/ads-manager/page/
// DynamicImports.tsx). ssr:false - charts measure the DOM.

export const DimensionPerformancePanel = dynamic(
  () =>
    import('./DimensionPerformancePanel').then((mod) => ({
      default: mod.DimensionPerformancePanel,
    })),
  {
    loading: () => <Skeleton className="h-56 w-full rounded-xl" />,
    ssr: false,
  }
);

export const LongevityDistributionChart = dynamic(
  () =>
    import('./LongevityDistributionChart').then((mod) => ({
      default: mod.LongevityDistributionChart,
    })),
  {
    loading: () => <Skeleton className="h-40 w-full rounded-xl" />,
    ssr: false,
  }
);

export const SurvivalCurveChart = dynamic(
  () =>
    import('./desk/SurvivalCurveChart').then((mod) => ({
      default: mod.SurvivalCurveChart,
    })),
  {
    loading: () => <Skeleton className="h-56 w-full rounded-xl" />,
    ssr: false,
  }
);

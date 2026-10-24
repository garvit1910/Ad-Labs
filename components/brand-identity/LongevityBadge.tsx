'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  longevityBucket,
  type LongevityBucketKey,
} from '@/lib/brand-identity/longevity';

const BUCKET_STYLES: Record<LongevityBucketKey, string> = {
  lt14: 'bg-slate-100 text-slate-600 dark:bg-slate-500/10 dark:text-slate-300',
  d14_30: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
  d30_60: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  winner:
    'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
};

export function LongevityBadge({
  days,
  className,
}: {
  days: number;
  className?: string;
}) {
  const bucket = longevityBucket(days);
  const t = useTranslations('BrandIdentity.longevity');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        BUCKET_STYLES[bucket],
        className
      )}
      title={t('deliveringFor', { days })}
    >
      {/* Longevity tier only - "winner" is the cohort-relative isWinner()
          classification, which a per-ad badge can't derive from days alone. */}
      {bucket === 'winner' ? t('badgeWinner', { days }) : t('badge', { days })}
    </span>
  );
}

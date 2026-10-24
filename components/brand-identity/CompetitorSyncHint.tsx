'use client';

/**
 * Slim work-in-progress row for the Competitor Analysis overview: shows how
 * many tracked competitors still have an ad scrape in flight. Derived from
 * the already-mounted `useCompetitors()` data (which polls at 3s while any
 * competitor is syncing) - zero additional fetches. Renders nothing once
 * every scrape has landed.
 */
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { TrackedCompetitor } from '@/lib/brand-identity/types';

export function CompetitorSyncHint({
  competitors,
}: {
  competitors: TrackedCompetitor[];
}) {
  const t = useTranslations('BrandIdentity.syncHint');
  const syncingCount = competitors.filter(
    (competitor) => competitor.syncing,
  ).length;
  if (syncingCount === 0) return null;
  return (
    <div className="glass-pill inline-flex w-fit items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-text motion-reduce:animate-none" />
      <span>
        {t.rich('syncing', {
          count: syncingCount,
          b: (chunks) => <b className="text-foreground">{chunks}</b>,
        })}
      </span>
    </div>
  );
}

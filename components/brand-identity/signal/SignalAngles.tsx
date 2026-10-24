'use client';

import { useState, type HTMLAttributes } from 'react';
import { Layers } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AngleCluster } from '@/lib/brand-identity/types';
import type { SelectAd } from '../ad-selection-context';
import { useBrandIdentityNumbers } from '../dashboard-shared';

/** How many angles the inline panel shows before the "View all angles" modal. */
export const SIGNAL_ANGLE_PREVIEW_LIMIT = 5;

/**
 * One angle row: label + counts on the left, a shared-scale momentum bar (bar
 * width = win rate) on the right. Rendered identically inline and inside the
 * "all angles" modal so the two surfaces can never drift.
 */
function AngleRow({
  cluster,
  showCompetitor,
  onSelectAd,
}: {
  cluster: AngleCluster;
  showCompetitor: boolean;
  onSelectAd: SelectAd;
}) {
  const t = useTranslations('BrandIdentity.signal.angles');
  const { pct } = useBrandIdentityNumbers();
  const members = cluster.members.map((member) => member.ad);
  const winning = cluster.winRate > 0;
  const width = Math.max(3, Math.round(cluster.winRate * 100));
  const interactive = members.length > 0;

  const rowProps: HTMLAttributes<HTMLDivElement> = interactive
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: () => onSelectAd(members[0], members),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelectAd(members[0], members);
          }
        },
      }
    : {};

  return (
    <div
      {...rowProps}
      className={`grid grid-cols-1 gap-3 border-t border-border/60 px-4 py-4 first:border-t-0 sm:grid-cols-[1fr_220px] sm:items-center ${
        interactive ? 'cursor-pointer hover:bg-accent/30' : ''
      }`}
    >
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-semibold leading-snug">
          {cluster.labelIsPlaceholder ? t('untitledAngle') : cluster.label}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {showCompetitor && <>{cluster.competitorName} · </>}
          {t.rich('stats', {
            ads: cluster.replicationCount,
            pct: pct(cluster.winRate),
            days: cluster.medianLongevity,
            n: (chunks) => <span className="tabular-nums">{chunks}</span>,
            win: (chunks) => (
              <span className={`tabular-nums ${winning ? 'font-bold text-brand-primary' : ''}`}>
                {chunks}
              </span>
            ),
          })}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${
              winning ? 'bg-brand-primary' : 'bg-muted-foreground/40'
            }`}
            style={{ width: `${width}%` }}
          />
        </div>
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {pct(cluster.winRate)}
        </span>
      </div>
    </div>
  );
}

/**
 * The Signal "Angles they're scaling" section: one shared-scale momentum bar
 * per angle (bar width = win rate), so relative scaling reads down the column.
 * The brand accent is reserved for angles that actually have winners - zero-win
 * angles render a muted bar and visibly recede. Each row opens its cluster's
 * ads in the shared detail sheet (arrowable through the member set).
 *
 * Rows are always ranked by win rate descending (the momentum the bar encodes),
 * so the strongest-scaling angles read from the top down. This re-sorts the
 * incoming `angleClusters` (delivered size-first from `buildAngleClusters`) for
 * this presentation only - the shared builder's order is unchanged. Ties break
 * by cluster size then id so the order is stable across refetches.
 *
 * Only the top `SIGNAL_ANGLE_PREVIEW_LIMIT` angles render inline; the rest stay
 * one click away in a scrollable modal (same ranking, same rows). Selecting an
 * angle from the modal closes it first so the shared AdDetailSheet opens cleanly
 * instead of stacking behind it.
 */
export function SignalAngles({
  clusters,
  showCompetitor,
  onSelectAd,
}: {
  clusters: AngleCluster[];
  /** Tag each row with its competitor in the all-competitors view. */
  showCompetitor: boolean;
  onSelectAd: SelectAd;
}) {
  const [open, setOpen] = useState(false);
  const t = useTranslations('BrandIdentity.signal.angles');

  if (clusters.length === 0) return null;

  const rankedClusters = [...clusters].sort(
    (a, b) =>
      b.winRate - a.winRate ||
      b.replicationCount - a.replicationCount ||
      (a.clusterId < b.clusterId ? -1 : 1)
  );
  const previewClusters = rankedClusters.slice(0, SIGNAL_ANGLE_PREVIEW_LIMIT);
  const hasMore = rankedClusters.length > previewClusters.length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="space-y-3">
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          {previewClusters.map((cluster) => (
            <AngleRow
              key={cluster.clusterId}
              cluster={cluster}
              showCompetitor={showCompetitor}
              onSelectAd={onSelectAd}
            />
          ))}
        </div>

        {hasMore && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => setOpen(true)}
            >
              <Layers className="h-4 w-4" />
              {t('viewAll')}
              <span className="text-muted-foreground">
                {t('count', { count: rankedClusters.length })}
              </span>
            </Button>
          </div>
        )}
      </div>

      <DialogContent
        className="flex max-h-[85vh] flex-col gap-4 sm:max-w-3xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            {t('title')}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            {rankedClusters.map((cluster) => (
              <AngleRow
                key={cluster.clusterId}
                cluster={cluster}
                showCompetitor={showCompetitor}
                onSelectAd={(ad, ads) => {
                  setOpen(false);
                  onSelectAd(ad, ads);
                }}
              />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

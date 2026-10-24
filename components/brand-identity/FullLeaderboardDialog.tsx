'use client';

import { adGridClass } from './ad-grid';
import { useState } from 'react';
import { Award } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { EnrichedAd, WinningAd } from '@/lib/brand-identity/types';
import { AdCard } from './AdCard';

/**
 * "View full leaderboard" button + modal. Sits under the top-winning-creatives
 * strip and opens the full win-score-ranked grid in a scrollable dialog.
 * Selecting an ad closes the dialog first so the shared AdDetailSheet opens
 * cleanly instead of stacking behind it.
 */
export function FullLeaderboardDialog({
  winners,
  onSelectAd,
}: {
  winners: WinningAd[];
  onSelectAd: (_ad: EnrichedAd) => void;
}) {
  const [open, setOpen] = useState(false);
  const t = useTranslations('BrandIdentity.leaderboard');
  if (winners.length === 0) return null;
  const strong = (chunks: React.ReactNode) => (
    <span className="font-medium">{chunks}</span>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex justify-center">
        <Button variant="outline" className="gap-2" onClick={() => setOpen(true)}>
          <Award className="h-4 w-4" />
          {t('viewFull')}
          <span className="text-muted-foreground">
            {t('count', { count: winners.length })}
          </span>
        </Button>
      </div>

      <DialogContent
        className="flex max-h-[85vh] flex-col gap-4 sm:max-w-5xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Award className="h-5 w-5" />
            {t('title')}
          </DialogTitle>
          <DialogDescription>
            {t.rich('description', {
              score: (chunks) => (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="cursor-help font-medium text-brand-primary underline decoration-dotted underline-offset-2"
                >
                  {chunks}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-left">
                <p className="font-medium">{t('tooltip.title')}</p>
                <p className="mt-1">{t('tooltip.intro')}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  <li>{t.rich('tooltip.longevity', { b: strong })}</li>
                  <li>{t.rich('tooltip.replication', { b: strong })}</li>
                  <li>{t.rich('tooltip.reach', { b: strong })}</li>
                </ul>
                <p className="mt-1">{t('tooltip.weighting')}</p>
              </TooltipContent>
            </Tooltip>
              ),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
          <div className={adGridClass('compact')}>
            {winners.map((winner) => (
              <AdCard
                key={winner.ad.id}
                ad={winner.ad}
                onClick={() => {
                  setOpen(false);
                  onSelectAd(winner.ad);
                }}
              />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

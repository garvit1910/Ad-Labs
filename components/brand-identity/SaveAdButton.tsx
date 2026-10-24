'use client';

import { useState, type SyntheticEvent } from 'react';
import { Bookmark } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { EnrichedAd } from '@/lib/brand-identity/types';
import {
  useCollections,
  useCollectionsMembership,
} from '@/hooks/brand-identity/useCollections';
import { SaveToCollectionPopover } from './SaveToCollectionPopover';

/**
 * Bookmark control that opens the save-to-collection popover. Filled when the
 * ad is saved anywhere in the org. Clicking always opens the popover (it never
 * blind-removes - an ad can live in multiple collections).
 *
 * Variants:
 *  - `overlay` - round dark button for absolutely-positioned media overlays.
 *  - `icon`    - ghost icon for the no-media card strip.
 *  - `inline`  - labelled button for the ad detail sheet header.
 *
 * On clickable ad cards this MUST stop propagation so it doesn't also open the
 * card's detail sheet.
 */
export function SaveAdButton({
  ad,
  variant = 'overlay',
  className,
}: {
  ad: EnrichedAd;
  variant?: 'overlay' | 'icon' | 'inline';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const t = useTranslations('BrandIdentity.saveAd');
  // Warm the collections list (shared/deduped per org) so the popover renders
  // its rows instantly on open instead of fetching after the click.
  useCollections();
  const { data: membership } = useCollectionsMembership();
  const isSaved =
    (membership?.[`${ad.platform}:${ad.external_ad_id}`]?.length ?? 0) > 0;

  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const stopKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === 'inline' ? (
          <Button
            type="button"
            variant={isSaved ? 'secondary' : 'outline'}
            size="sm"
            className={className}
            onClick={stop}
            onKeyDown={stopKeys}
          >
            <Bookmark className={cn('h-4 w-4', isSaved && 'fill-current')} />
            {isSaved ? t('saved') : t('save')}
          </Button>
        ) : (
          <button
            type="button"
            aria-label={isSaved ? t('savedAria') : t('saveAria')}
            onClick={stop}
            onPointerDown={stop}
            onKeyDown={stopKeys}
            className={cn(
              variant === 'overlay'
                ? 'flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white ring-2 ring-white/70 transition hover:bg-black/75'
                : 'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground',
              variant === 'icon' && isSaved && 'text-brand-primary',
              className
            )}
          >
            <Bookmark className={cn('h-4 w-4', isSaved && 'fill-current')} />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-0"
        onClick={stop}
        onKeyDown={stop}
      >
        <SaveToCollectionPopover ad={ad} />
      </PopoverContent>
    </Popover>
  );
}

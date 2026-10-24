'use client';

import { Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { EnrichedAd } from '@/lib/brand-identity/types';
import { firstResolvedBody } from '@/lib/brand-identity/creative-text';
import { LongevityBadge } from './LongevityBadge';
import { SaveAdButton } from './SaveAdButton';
import { useBrandIdentityNumbers } from './dashboard-shared';
import { useTaxonomyLabels } from './i18n/taxonomy-labels';

export function AdCard({
  ad,
  onClick,
}: {
  ad: EnrichedAd;
  onClick?: () => void;
}) {
  const body = firstResolvedBody(ad.creative_bodies, ad.page_name) ?? '';
  const preview = ad.hosted_media_urls?.[0] ?? ad.media_urls?.[0];
  const hasVideo = (ad.video_urls?.length ?? 0) > 0;
  const t = useTranslations('BrandIdentity.adCard');
  const tx = useTaxonomyLabels();
  const numbers = useBrandIdentityNumbers();

  return (
    <Card
      variant="plain"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick?.();
        }
      }}
      className="group flex h-full cursor-pointer flex-col gap-0 overflow-hidden border-neutral-200/80 p-0 shadow-none transition-shadow hover:shadow-md"
    >
      {preview ? (
        <div className="relative aspect-square w-full overflow-hidden bg-muted">
          {/* Snapshot previews come from Facebook's CDN, so a plain img avoids
              next/image remote-pattern config. For video ads this is the
              poster frame; the mp4 lives in video_urls and plays in the detail
              sheet. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt={ad.page_name ?? t('imageAlt')}
            loading="lazy"
            // Snapshot/CDN URLs can expire (esp. for saved ads viewed later) -
            // hide a broken image so the muted backdrop shows instead of a
            // broken-image icon. The ad's copy and labels still render.
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden';
            }}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
          {hasVideo && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="rounded-full bg-black/55 p-3">
                <Play className="h-6 w-6 fill-white text-white" />
              </span>
            </div>
          )}
          <div className="absolute left-2 top-2 flex items-center gap-1.5">
            <LongevityBadge days={ad.longevity_days} />
          </div>
          <span
            className={cn(
              'absolute right-2 top-2 h-2.5 w-2.5 rounded-full ring-2 ring-white/80',
              ad.is_active ? 'bg-emerald-500' : 'bg-slate-400'
            )}
            title={ad.is_active ? t('stillDelivering') : t('stopped')}
          />
          {ad.media_type && ad.media_type !== 'unknown' && (
            <Badge
              variant="secondary"
              className="absolute bottom-2 right-2 bg-black/60 text-white"
            >
              {tx.isEnglish ? ad.media_type : tx.label(ad.media_type)}
            </Badge>
          )}
          <div className="absolute bottom-2 left-2 z-10">
            <SaveAdButton ad={ad} variant="overlay" />
          </div>
        </div>
      ) : (
        // No media - show a slim signal strip rather than a placeholder image.
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <LongevityBadge days={ad.longevity_days} />
          <div className="flex items-center gap-1.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  ad.is_active ? 'bg-emerald-500' : 'bg-slate-400'
                )}
              />
              {ad.is_active ? t('active') : t('stopped')}
            </span>
            <SaveAdButton ad={ad} variant="icon" />
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {ad.page_name}
          </span>
          {ad.eu_total_reach != null && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t('reach', { reach: numbers.reach(ad.eu_total_reach) })}
            </span>
          )}
        </div>

        <p className="line-clamp-3 text-sm leading-snug">
          {ad.hook_text ?? body}
        </p>

        <div className="mt-auto flex flex-wrap gap-1">
          {ad.hook_archetype && (
            <Badge variant="outline" className={cn('text-[10px]', tx.capitalizeClass)}>
              {tx.label(ad.hook_archetype)}
            </Badge>
          )}
          {ad.angle && (
            <Badge variant="outline" className={cn('text-[10px]', tx.capitalizeClass)}>
              {tx.label(ad.angle)}
            </Badge>
          )}
          {(ad.persona_universal ?? ad.persona) && (
            <Badge variant="outline" className={cn('text-[10px]', tx.capitalizeClass)}>
              {tx.label((ad.persona_universal ?? ad.persona)!)}
            </Badge>
          )}
          {ad.format && (
            <Badge variant="outline" className={cn('text-[10px]', tx.capitalizeClass)}>
              {tx.label(ad.format)}
            </Badge>
          )}
          {ad.style && (
            <Badge variant="secondary" className={cn('text-[10px]', tx.capitalizeClass)}>
              {tx.label(ad.style)}
            </Badge>
          )}
          {ad.offer_type && (
            <Badge
              variant="outline"
              className={cn(
                'border-brand-primary/40 text-[10px] text-brand-primary',
                tx.capitalizeClass,
              )}
            >
              {tx.label(ad.offer_type)}
            </Badge>
          )}
        </div>
      </div>
    </Card>
  );
}

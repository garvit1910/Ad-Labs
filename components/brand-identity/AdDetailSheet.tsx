'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AiTranslatedBadge } from '@/components/i18n/AiTranslatedBadge';
import { useLocalizedAdSummary } from '@/hooks/brand-identity/useLocalizedAdSummary';
import { useFormatLocale } from '@/hooks/useFormatLocale';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { EnrichedAd } from '@/lib/brand-identity/types';
import { resolveCopyList } from '@/lib/brand-identity/creative-text';
import { useTaxonomyLabels, type TaxonomyLabels } from './i18n/taxonomy-labels';
import { LongevityBadge } from './LongevityBadge';
import { SaveAdButton } from './SaveAdButton';

const DURATION_BUCKET_LABELS: Record<string, string> = {
  lt15: '<15s',
  '15_30': '15–30s',
  '30_60': '30–60s',
  gt60: '>60s',
};

function formatDate(iso: string | null, locale?: string): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type CreativeCard = { video?: string; poster?: string };

/**
 * Resolves an ad's creative into one card per carousel slide. `media_urls`
 * holds one still per card; `video_urls` one mp4 per video card. Videos pair
 * with posters by index only when every card is a video (equal-length arrays)
 * or there is a single media item; for a mixed carousel the nonEmpty-collapsed
 * `video_urls` can't be paired by card index, so those cards fall back to their
 * still image rather than risk pairing a video with the wrong card's poster.
 */
export function buildCreativeCards(ad: EnrichedAd): CreativeCard[] {
  const media = ad.media_urls ?? [];
  const videos = ad.video_urls ?? [];
  const hostedMedia = ad.hosted_media_urls ?? [];
  const hostedVideos = ad.hosted_video_urls ?? [];
  const count = Math.max(media.length, videos.length);
  const aligned = videos.length === media.length || media.length <= 1;
  return Array.from({ length: count }, (_, i) => ({
    video: aligned ? (hostedVideos[i] ?? videos[i]) : undefined,
    poster: hostedMedia[i] ?? media[i],
  })).filter((card) => card.video || card.poster);
}

function CardMedia({ card }: { card: CreativeCard }) {
  const t = useTranslations('BrandIdentity.adDetail');
  const [videoFailed, setVideoFailed] = useState(false);
  useEffect(() => setVideoFailed(false), [card.video]);

  const youtubeId = card.video ? parseYouTubeVideoId(card.video) : null;
  if (youtubeId) {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-lg border bg-black">
        <iframe
          src={`https://www.youtube.com/embed/${youtubeId}`}
          title={t('videoTitle')}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          className="h-full w-full"
        />
      </div>
    );
  }
  if (card.video && !videoFailed) {
    return (
      <video
        src={card.video}
        poster={card.poster}
        controls
        playsInline
        preload="metadata"
        onError={() => setVideoFailed(true)}
        className="w-full rounded-lg border bg-black"
      />
    );
  }
  if (videoFailed) {
    return (
      <div className="space-y-2">
        {card.poster && <PosterImage src={card.poster} />}
        <p className="text-xs text-muted-foreground">
          {t('videoUnavailable')}
        </p>
      </div>
    );
  }
  if (card.poster) {
    return <PosterImage src={card.poster} />;
  }
  return null;
}

function PosterImage({ src, alt }: { src: string; alt?: string }) {
  const t = useTranslations('BrandIdentity.adDetail');
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? t('previewAlt')}
      onError={(event) => {
        event.currentTarget.style.visibility = 'hidden';
      }}
      className="w-full rounded-lg border object-cover"
    />
  );
}

function parseYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const id =
      host === 'youtu.be'
        ? parsed.pathname.split('/').filter(Boolean)[0]
        : host === 'youtube.com' || host === 'm.youtube.com'
          ? parsed.searchParams.get('v')
          : null;
    return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function CreativeCards({ cards }: { cards: CreativeCard[] }) {
  const t = useTranslations('BrandIdentity.adDetail');
  const [active, setActive] = useState(0);
  if (cards.length === 0) return null;
  if (cards.length === 1) return <CardMedia card={cards[0]} />;

  const current = cards[Math.min(active, cards.length - 1)];
  return (
    <div className="space-y-2">
      <CardMedia key={active} card={current} />
      <div className="flex gap-2 overflow-x-auto pb-1">
        {cards.map((card, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setActive(index)}
            aria-label={t('showCard', { index: index + 1, total: cards.length })}
            aria-current={index === active}
            className={cn(
              'relative h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-muted transition',
              index === active
                ? 'border-brand-primary ring-1 ring-brand-primary'
                : 'border-border opacity-60 hover:opacity-100'
            )}
          >
            {card.poster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={card.poster}
                alt=""
                onError={(event) => {
                  event.currentTarget.style.visibility = 'hidden';
                }}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[11px] font-medium text-muted-foreground">
                {index + 1}
              </span>
            )}
            {card.video && (
              <span className="absolute inset-0 flex items-center justify-center">
                <Play className="h-4 w-4 fill-white text-white drop-shadow" />
              </span>
            )}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('carouselPosition', {
          index: Math.min(active, cards.length - 1) + 1,
          total: cards.length,
        })}
      </p>
    </div>
  );
}

function LabelRow({
  label,
  value,
  tx,
}: {
  label: string;
  value: string | null;
  tx: TaxonomyLabels;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('text-right font-medium', tx.capitalizeClass)}>
        {value ? tx.label(value) : '-'}
      </span>
    </div>
  );
}

export function AdDetailSheet({
  ad,
  ads,
  open,
  onOpenChange,
}: {
  ad: EnrichedAd | null;
  /**
   * Optional win-score-ranked list this ad belongs to (the matrix passes a
   * tactic's full example set). When it has 2+ entries the sheet shows prev/next
   * arrows to page through every ad; grids omit it → a single, arrow-less ad.
   */
  ads?: EnrichedAd[];
  open: boolean;
  onOpenChange: (_open: boolean) => void;
}) {
  const t = useTranslations('BrandIdentity.adDetail');
  const tx = useTaxonomyLabels();
  const formatLocale = useFormatLocale();
  const list = ads && ads.length > 0 ? ads : ad ? [ad] : [];
  const [index, setIndex] = useState(0);
  // A fresh selection (new opening ad) resets to the first example.
  useEffect(() => setIndex(0), [ad?.id]);
  const hasNav = list.length > 1;
  useEffect(() => {
    if (!open || !hasNav) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setIndex((i) => (i - 1 + list.length) % list.length);
      else if (e.key === 'ArrowRight') setIndex((i) => (i + 1) % list.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hasNav, list.length]);

  const current = list[Math.min(index, list.length - 1)] ?? null;
  // The labeller's summary is AI prose → viewer's language when translated (WS6).
  // hook_text stays as stored: it is the ad's own copy, quoted verbatim.
  const summary = useLocalizedAdSummary(list, Math.min(index, list.length - 1));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {current && (
          <>
            <SheetHeader>
              <div className="flex items-start justify-between gap-2 pr-6">
                <SheetTitle className="flex items-center gap-2">
                  {current.page_name ?? t('fallbackTitle')}
                  <LongevityBadge days={current.longevity_days} />
                </SheetTitle>
                <SaveAdButton ad={current} variant="inline" />
              </div>
              <SheetDescription className="flex items-center gap-2">
                <span
                  className={
                    current.is_active
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-muted-foreground'
                  }
                >
                  {current.is_active ? t('stillDelivering') : t('stopped')}
                </span>
                <span>·</span>
                <span>
                  {formatDate(current.delivery_start, formatLocale)} →{' '}
                  {formatDate(current.delivery_stop, formatLocale) === '-'
                    ? t('now')
                    : formatDate(current.delivery_stop, formatLocale)}
                </span>
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-8">
              {hasNav && (
                <div className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1">
                  <button
                    type="button"
                    onClick={() => setIndex((i) => (i - 1 + list.length) % list.length)}
                    aria-label={t('previousAd')}
                    className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-primary"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('adPosition', { index: index + 1, total: list.length })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setIndex((i) => (i + 1) % list.length)}
                    aria-label={t('nextAd')}
                    className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-primary"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}

              <CreativeCards key={current.id} cards={buildCreativeCards(current)} />

              {(() => {
                // Feed-driven Google ads scrape as raw "{{product.brand}}"
                // template tokens (Transparency Center shows the template, not
                // resolved values). Swap each token for the competitor's page
                // name - the closest real value we have - rather than the token.
                const bodies = resolveCopyList(current.creative_bodies, current.page_name);
                const titles = resolveCopyList(current.creative_link_titles, current.page_name);
                if (bodies.length === 0 && titles.length === 0) return null;
                return (
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">{t('creativeText')}</h3>
                    {bodies.map((body, index) => (
                      <p
                        key={index}
                        className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm leading-relaxed"
                      >
                        {body}
                      </p>
                    ))}
                    {titles.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {titles.map((title, index) => (
                          <Badge key={index} variant="secondary">
                            {title}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })()}

              <Separator />

              <section className="space-y-2">
                {current.hook_archetype ? (
                  <div className="space-y-1.5">
                    <LabelRow tx={tx} label={t('fields.hookArchetype')} value={current.hook_archetype} />
                    <LabelRow tx={tx} label={t('fields.angle')} value={current.angle} />
                    <LabelRow
                      tx={tx}
                      label={t('fields.persona')}
                      value={current.persona ?? current.persona_universal}
                    />
                    <LabelRow tx={tx} label={t('fields.funnelStage')} value={current.funnel_stage} />
                    <LabelRow tx={tx} label={t('fields.format')} value={current.format} />
                    {current.style && (
                      <LabelRow tx={tx} label={t('fields.style')} value={current.style} />
                    )}
                    {current.aspect_ratio && (
                      <LabelRow tx={tx} label={t('fields.aspectRatio')} value={current.aspect_ratio} />
                    )}
                    <LabelRow tx={tx} label={t('fields.offer')} value={current.offer_type ?? 'none'} />
                    {current.fingerprint && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {current.fingerprint.talking_head && (
                          <Badge variant="secondary" className="text-[10px]">{t('fingerprint.talkingHead')}</Badge>
                        )}
                        {current.fingerprint.people_present && !current.fingerprint.talking_head && (
                          <Badge variant="secondary" className="text-[10px]">{t('fingerprint.people')}</Badge>
                        )}
                        {current.fingerprint.text_overlay && (
                          <Badge variant="secondary" className="text-[10px]">{t('fingerprint.textOverlay')}</Badge>
                        )}
                        {current.fingerprint.voiceover && (
                          <Badge variant="secondary" className="text-[10px]">{t('fingerprint.voiceover')}</Badge>
                        )}
                        {current.fingerprint.setting && (
                          <Badge variant="secondary" className={cn('text-[10px]', tx.capitalizeClass)}>
                            {tx.isEnglish
                              ? `${current.fingerprint.setting} setting`
                              : t('fingerprint.setting', { value: tx.label(current.fingerprint.setting) })}
                          </Badge>
                        )}
                        {current.fingerprint.pacing && (
                          <Badge variant="secondary" className={cn('text-[10px]', tx.capitalizeClass)}>
                            {tx.isEnglish
                              ? `${current.fingerprint.pacing} pacing`
                              : t('fingerprint.pacing', { value: tx.label(current.fingerprint.pacing) })}
                          </Badge>
                        )}
                        {current.fingerprint.tone && (
                          <Badge variant="secondary" className={cn('text-[10px]', tx.capitalizeClass)}>
                            {tx.isEnglish
                              ? `${tx.label(current.fingerprint.tone)} tone`
                              : t('fingerprint.tone', { value: tx.label(current.fingerprint.tone) })}
                          </Badge>
                        )}
                        {current.fingerprint.duration_bucket && (
                          <Badge variant="secondary" className="text-[10px]">
                            {DURATION_BUCKET_LABELS[current.fingerprint.duration_bucket]}
                          </Badge>
                        )}
                        {current.fingerprint.captions && (
                          <Badge variant="secondary" className="text-[10px]">{t('fingerprint.captions')}</Badge>
                        )}
                        {current.fingerprint.music && (
                          <Badge variant="secondary" className="text-[10px]">{t('fingerprint.music')}</Badge>
                        )}
                      </div>
                    )}
                    {current.fingerprint?.spoken_hook && (
                      <div className="pt-1 text-sm">
                        <span className="text-muted-foreground">{t('spokenHook')} </span>
                        <span className="italic">“{current.fingerprint.spoken_hook}”</span>
                      </div>
                    )}
                    {current.fingerprint?.visual_hook && (
                      <div className="pt-1 text-sm">
                        <span className="text-muted-foreground">{t('visualHook')} </span>
                        <span className="italic">“{current.fingerprint.visual_hook}”</span>
                      </div>
                    )}
                    {current.hook_text && (
                      <div className="pt-1 text-sm">
                        <span className="text-muted-foreground">{t('hook')} </span>
                        <span className="italic">“{current.hook_text}”</span>
                      </div>
                    )}
                    {summary.summary && (
                      <div className="space-y-1">
                        <p className="text-sm text-muted-foreground">{summary.summary}</p>
                        {summary.translated && <AiTranslatedBadge />}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('notLabeled')}
                  </p>
                )}
              </section>

              <Separator />

              <section className="space-y-1.5">
                <h3 className="text-sm font-semibold">{t('delivery')}</h3>
                <LabelRow
                  tx={tx}
                  label={t('fields.firstSeen')}
                  value={formatDate(current.first_seen_at, formatLocale)}
                />
                <LabelRow
                  tx={tx}
                  label={t('fields.lastSeen')}
                  value={formatDate(current.last_seen_at, formatLocale)}
                />
                <LabelRow
                  tx={tx}
                  label={t('fields.reachEu')}
                  value={
                    current.eu_total_reach != null
                      ? current.eu_total_reach.toLocaleString(formatLocale)
                      : null
                  }
                />
                <LabelRow
                  tx={tx}
                  label={t('fields.platforms')}
                  value={(current.publisher_platforms ?? []).join(', ') || null}
                />
                {current.ad_snapshot_url && (
                  <a
                    href={current.ad_snapshot_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 pt-1 text-sm text-brand-primary hover:underline"
                  >
                    {t('viewInAdLibrary')} <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

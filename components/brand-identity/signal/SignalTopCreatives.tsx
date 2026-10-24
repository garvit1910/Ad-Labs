'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight, Trophy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { EnrichedAd, WinningAd } from '@/lib/brand-identity/types';
import type { SelectAd } from '../ad-selection-context';
import { useTaxonomyLabels } from '../i18n/taxonomy-labels';

/** Total creatives shown = one hero + up to five supporting minis. */
const HERO_COUNT = 6;

/**
 * The hero media box is locked to the tallest ratio in the creative taxonomy
 * (`ASPECT_RATIOS` in services/ad-library/label-taxonomy.ts — 9:16), so a
 * portrait creative fits without cropping and every shorter ratio letterboxes
 * inside the same box. Paired with object-contain below, this also keeps the
 * card height constant while paging the tied set, so the layout never jumps.
 */
const HERO_MEDIA_ASPECT = 'aspect-[9/16]';

function previewUrl(ad: EnrichedAd): string | null {
  return ad.hosted_media_urls?.[0] ?? ad.media_urls?.[0] ?? null;
}

function Thumb({ ad, className }: { ad: EnrichedAd; className: string }) {
  const t = useTranslations('BrandIdentity.signal.top');
  const src = previewUrl(ad);
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={ad.page_name ?? t('imageAlt')}
        loading="lazy"
        className={className}
      />
    );
  }
  return (
    <div
      className={`flex items-center justify-center px-3 text-center text-xs text-muted-foreground ${className}`}
    >
      {ad.hook_text ?? ad.creative_bodies?.[0] ?? t('noPreview')}
    </div>
  );
}

function Fact({
  value,
  label,
  hot,
  capitalize,
}: {
  value: string;
  label: string;
  hot?: boolean;
  capitalize?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span
        className={`text-lg font-semibold tabular-nums ${
          hot ? 'text-brand-primary' : 'text-foreground'
        } ${capitalize ? 'capitalize' : ''}`}
      >
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/** Edge chevron for paging the hero through creatives tied for the #1 score. */
function CarouselArrow({
  side,
  onClick,
  label,
}: {
  side: 'left' | 'right';
  onClick: () => void;
  label: string;
}) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`absolute top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm transition hover:bg-card ${
        side === 'left' ? 'left-2' : 'right-2'
      }`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

/**
 * The Signal "Top winning creatives" section: the #1 creative featured large
 * with its facts spelled out, then the supporting winners in a tight grid.
 * Hierarchy replaces the classic six-identical-cards repetition. Brand accent is
 * reserved for the win score, so scanning the scores reads as scanning winners.
 *
 * When several creatives are tied for the top score there is no single #1, so the
 * hero gains left/right arrows to page through just that tied set (and only then).
 */
export function SignalTopCreatives({
  winners,
  onSelectAd,
}: {
  winners: WinningAd[];
  onSelectAd: SelectAd;
}) {
  const [featuredIdx, setFeaturedIdx] = useState(0);
  const t = useTranslations('BrandIdentity.signal.top');
  const tx = useTaxonomyLabels();

  if (winners.length === 0) return null;

  // Winners are sorted by score descending, so the tied leaders sit contiguously
  // at the front — but filter by score to stay correct regardless of ordering.
  const topScore = winners[0].winScore;
  const tiedTop = winners.filter((winner) => winner.winScore === topScore);
  const hasCarousel = tiedTop.length > 1;

  // Tolerate the tied set shrinking on a data refresh without going out of range.
  const activeIdx = featuredIdx % tiedTop.length;
  const hero = tiedTop[activeIdx];
  const heroAd = hero.ad;

  const goPrev = () =>
    setFeaturedIdx((i) => (i - 1 + tiedTop.length) % tiedTop.length);
  const goNext = () => setFeaturedIdx((i) => (i + 1) % tiedTop.length);

  // Supporting winners: every other winner, minus whichever tied leader is featured.
  const rest = winners
    .filter((winner) => winner.ad.id !== heroAd.id)
    .slice(0, HERO_COUNT - 1);

  return (
    <div className="space-y-4">
      <div className="relative">
        {hasCarousel && (
          <>
            <CarouselArrow
              side="left"
              onClick={goPrev}
              label={t('previousTied')}
            />
            <CarouselArrow
              side="right"
              onClick={goNext}
              label={t('nextTied')}
            />
          </>
        )}
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelectAd(heroAd)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelectAd(heroAd);
            } else if (hasCarousel && event.key === 'ArrowLeft') {
              event.preventDefault();
              goPrev();
            } else if (hasCarousel && event.key === 'ArrowRight') {
              event.preventDefault();
              goNext();
            }
          }}
          className="group grid cursor-pointer grid-cols-1 gap-5 rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-md sm:grid-cols-[minmax(0,260px)_1fr] sm:p-5"
        >
          <div
            className={`relative mx-auto w-full max-w-[15rem] overflow-hidden rounded-xl bg-muted sm:max-w-none ${HERO_MEDIA_ASPECT}`}
          >
            <Thumb
              ad={heroAd}
              className="absolute inset-0 h-full w-full object-contain"
            />
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-brand-primary px-2.5 py-1 text-xs font-bold text-white shadow-sm">
              <Trophy className="h-3 w-3" />
              {hero.winScore}
            </span>
          </div>
          <div className="flex flex-col justify-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-primary">
              {t('rankScore', { score: hero.winScore })}
              {hasCarousel ? t('tiedPosition', { index: activeIdx + 1, total: tiedTop.length }) : ''}
            </span>
            <h3 className="text-xl font-bold leading-tight">
              {heroAd.page_name ?? t('topCreative')}
              {heroAd.format ? ` - ${tx.label(heroAd.format)}` : ''}
            </h3>
            <p className="max-w-[52ch] text-sm text-muted-foreground">
              {t('heroBody', { days: heroAd.longevity_days, variants: hero.replicationCount })}
            </p>
            <div className="mt-1 flex flex-wrap gap-x-7 gap-y-2">
              <Fact value={String(hero.winScore)} label={t('winScore')} hot />
              <Fact value={t('days', { days: heroAd.longevity_days })} label={t('delivering')} />
              <Fact value={`×${hero.replicationCount}`} label={t('variants')} />
              {heroAd.format && (
                <Fact value={tx.label(heroAd.format)} label={t('format')} capitalize={tx.isEnglish} />
              )}
            </div>
          </div>
        </div>
      </div>

      {rest.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {rest.map((winner) => (
            <div
              key={winner.ad.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectAd(winner.ad)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectAd(winner.ad);
                }
              }}
              className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-md"
            >
              <div className="relative overflow-hidden bg-muted">
                <Thumb ad={winner.ad} className="h-28 w-full object-cover" />
              </div>
              <div className="flex flex-col gap-0.5 p-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-bold tabular-nums text-brand-primary">
                    {winner.winScore}
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {t('days', { days: winner.ad.longevity_days })}
                  </span>
                </div>
                <span className="truncate text-[11px] text-muted-foreground">
                  {winner.ad.page_name}
                  {winner.ad.format ? ` · ${tx.label(winner.ad.format)}` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

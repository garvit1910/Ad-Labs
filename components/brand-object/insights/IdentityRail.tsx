'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  tailChapterNumbers,
  voiceTraits,
  type IdentityClaimRow,
} from '@/lib/brand-object/insights';
import { brandLogoUrlFromWebsite } from '@/lib/brand-object/brand-logo';
import { useLocaleFormatters } from '@/hooks/useLocaleFormatters';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';

/** The rail is a narrow sidebar — voice claims are already capped at 6 upstream,
 * but each can split into several traits, so cap the rendered pills too. */
const MAX_VOICE_PILLS = 8;

export function IdentityRail({
  brandName,
  websiteUrl = null,
  positioning,
  voice,
  mentionsKept,
  l1,
  personaCount,
  hasAlignment = false,
  hasPerformance = false,
  hasLandscape = false,
}: {
  brandName: string | null;
  websiteUrl?: string | null;
  positioning: IdentityClaimRow | null;
  voice: IdentityClaimRow[];
  mentionsKept: number | null;
  l1: {
    provenWinners: number;
    totalAds: number;
    competitorsTracked: number;
  } | null;
  personaCount: number;
  /** Chapter 05 only exists when there is something to align — the jump link
   * must not point at a section the dashboard never rendered. */
  hasAlignment?: boolean;
  /** "What's working for you" only mounts with labeled own-ad spend — same
   * no-dead-link rule. */
  hasPerformance?: boolean;
  /** The competitive landscape only mounts when the org listens to at least
   * one Brand Presence competitor with kept mentions — same rule. */
  hasLandscape?: boolean;
}) {
  const t = useTranslations('BrandReport');
  const formatters = useLocaleFormatters();
  // The two conditional tail chapters take their numbers from the SAME helper
  // the dashboard JSX reads, so the jump list and the headers never disagree.
  const tailNumbers = tailChapterNumbers({ hasPerformance, hasLandscape });
  const hasCoverage = mentionsKept != null || l1 != null || personaCount > 0;

  // One pill per quality, de-duplicated case-insensitively across claims —
  // two voice facts often repeat the same adjective.
  const seenTraits = new Set<string>();
  const voicePills: string[] = [];
  for (const claim of voice) {
    for (const trait of voiceTraits(claim.statement)) {
      const key = trait.toLowerCase();
      if (seenTraits.has(key)) continue;
      seenTraits.add(key);
      voicePills.push(trait);
      if (voicePills.length >= MAX_VOICE_PILLS) break;
    }
    if (voicePills.length >= MAX_VOICE_PILLS) break;
  }

  // Auto-import the brand mark from the founder's website (the site favicon is
  // almost always the logo). Fall back to the brand initial when we can't
  // derive a URL or the image fails to load. Reset the failure flag when the
  // brand switches so the new brand's logo gets a fresh attempt.
  const logoUrl = brandLogoUrlFromWebsite(websiteUrl);
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => {
    setLogoFailed(false);
  }, [logoUrl]);

  // Smooth-scroll the chapter jumps instead of the browser's instant hash jump;
  // `scroll-mt-*` on each section keeps them clear of the sticky header.
  const handleChapterClick = (
    event: React.MouseEvent<HTMLAnchorElement>,
    id: string,
  ) => {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${id}`);
  };

  return (
    <div className="glass-surface space-y-5 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        {logoUrl && !logoFailed ? (
          <img
            src={logoUrl}
            alt={
              brandName
                ? t('rail.logoAlt', { brand: brandName })
                : t('rail.logoAltGeneric')
            }
            className="h-10 w-10 shrink-0 rounded-xl border border-border/60 bg-white object-contain p-1"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand font-semibold text-white"
          >
            {brandName?.charAt(0).toUpperCase()}
          </div>
        )}
        <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
          {t('rail.eyebrow', { brand: brandName ?? t('rail.yourBrand') })}
        </p>
      </div>

      {positioning ? (
        <div className="space-y-3">
          <h2 className={cn(BI_TYPE.panelTitle, 'text-balance leading-snug sm:text-xl')}>
            {positioning.statement}
          </h2>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border/70 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('rail.noPositioning')}
          </p>
        </div>
      )}

      {voicePills.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
            {t('rail.voice')}
          </span>
          {voicePills.map((trait) => (
            <span
              key={trait}
              className="glass-pill rounded-full px-3 py-1 text-xs"
            >
              {trait}
            </span>
          ))}
        </div>
      )}

      {hasCoverage && (
        <div className="space-y-2">
          {mentionsKept != null && (
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {t('rail.keptMentions')}
              </span>
              <span className="font-semibold tabular-nums">
                {formatters.integer(mentionsKept)}
              </span>
            </div>
          )}
          {l1 != null && (
            <>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {t('rail.competitorsTracked')}
                </span>
                <span className="font-semibold tabular-nums">
                  {l1.competitorsTracked}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {t('rail.provenWinners')}
                </span>
                <span className="text-right font-semibold tabular-nums">
                  {t('rail.winnersOfAds', {
                    winners: formatters.integer(l1.provenWinners),
                    total: l1.totalAds,
                    totalLabel: formatters.integer(l1.totalAds),
                  })}
                </span>
              </div>
            </>
          )}
          {personaCount > 0 && (
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {t('rail.personas')}
              </span>
              <span className="font-semibold tabular-nums">{personaCount}</span>
            </div>
          )}
        </div>
      )}

      <nav
        aria-label={t('rail.chaptersAria')}
        className="flex flex-col gap-2 border-t border-border pt-3"
      >
        {[
          { id: 'identity', number: '01', label: t('chapterNav.identity') },
          { id: 'narrative', number: '02', label: t('chapterNav.narrative') },
          { id: 'customers', number: '03', label: t('chapterNav.customers') },
          { id: 'market', number: '04', label: t('chapterNav.market') },
          ...(hasAlignment
            ? [{ id: 'alignment', number: '05', label: t('chapterNav.alignment') }]
            : []),
          ...(personaCount > 0
            ? [{ id: 'personas', number: '06', label: t('chapterNav.personas') }]
            : []),
          ...(tailNumbers.performance
            ? [{ id: 'performance', number: tailNumbers.performance, label: t('chapterNav.performance') }]
            : []),
          ...(tailNumbers.landscape
            ? [{ id: 'landscape', number: tailNumbers.landscape, label: t('chapterNav.landscape') }]
            : []),
        ].map((chapter) => (
          <a
            key={chapter.id}
            href={`#${chapter.id}`}
            onClick={(event) => handleChapterClick(event, chapter.id)}
            className="flex items-baseline gap-2 text-xs text-muted-foreground hover:text-brand-text"
          >
            <span className="text-[11px] font-semibold tracking-wider text-muted-foreground/70">
              {chapter.number}
            </span>
            {chapter.label}
          </a>
        ))}
      </nav>
    </div>
  );
}

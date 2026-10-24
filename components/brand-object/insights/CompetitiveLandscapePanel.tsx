'use client';

/**
 * Chapter 07 — "The competitive landscape". Per competitor profile the org
 * listens to in Brand Presence, what customers say about that competitor set
 * beside what they say about the report's own brand. ZERO LLM: every number
 * and every headline arrives pre-computed from
 * `POST /api/brand-presence/insights/competitive-landscape`
 * (`lib/brand-presence/competitive-landscape.ts`) — this panel derives no new
 * number and never rewrites a quote (verbatim, CSS `line-clamp` only).
 * The dashboard mounts it only when `competitors.length > 0`.
 * REPORT-ONLY — evidence, never approvals.
 * Theme labels are AI-written; for a non-English viewer `useCompetitiveLandscape`
 * swaps in their cached translation, and the headline shows ONE "AI-translated"
 * marker when any label is translated (list keys stay on the English label).
 */
import { ExternalLink, Star } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { useLocaleFormatters } from '@/hooks/useLocaleFormatters';
import type { CompetitiveLandscapeResponse } from '@/lib/brand-presence/client-schemas';
import {
  isAiTranslatedLandscape,
  landscapeThemeKey,
} from '@/lib/brand-presence/localized-themes';
import { AiTranslatedBadge } from '@/components/i18n/AiTranslatedBadge';
import {
  LANDSCAPE_LEVEL_BAND_PCT,
  LANDSCAPE_MIN_SAMPLE,
} from '@/lib/brand-presence/competitive-landscape';
import type { ThemeKind } from '@/lib/brand-presence/types';
import type { ReportTreatment } from '@/lib/brand-object/insights';
import { PresenceRoleBadge } from '@/components/brand-presence/presence-role';
import { channelLabel } from '@/components/brand-presence/channel-style';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';
import { useVocKindTitle } from './report-copy';
import { NEUTRAL_PILL, sectionTone } from './section-tone';

type ProfileVoice = CompetitiveLandscapeResponse['self'];
type LandscapeQuote = NonNullable<ProfileVoice['topPraise']>;
type ContrastKind = CompetitiveLandscapeResponse['contrasts'][number]['kind'];

/**
 * Kind dots + titles. The hues mirror `VocReportPanel`'s KIND_CONFIG (chapter
 * 03) so a Praise dot means the same thing on every chapter — that config is
 * module-private there, so the four dot classes are restated once here.
 * Reading order: Praise and Pains first (the contrast a reader looks for),
 * then Desires/Objections when present.
 */
const THEME_KIND_ORDER: Array<{
  kind: ThemeKind;
  section: 'voc_praise' | 'voc_pain' | 'voc_desire' | 'voc_objection';
  dotClass: string;
}> = [
  { kind: 'praise', section: 'voc_praise', dotClass: 'bg-sky-500' },
  { kind: 'pain', section: 'voc_pain', dotClass: 'bg-rose-500' },
  { kind: 'desire', section: 'voc_desire', dotClass: 'bg-emerald-500' },
  { kind: 'objection', section: 'voc_objection', dotClass: 'bg-amber-500' },
];

type Contrast = CompetitiveLandscapeResponse['contrasts'][number];

/**
 * The contrast copy. `contrast.headline` / `.caption` arrive pre-written in
 * English by `buildLandscapeContrast` (lib/brand-presence/competitive-landscape.ts)
 * and English renders them unchanged; other locales rebuild the same branches
 * from the two voices the response already carries.
 */
export function useContrastCopy() {
  const t = useTranslations('BrandReport.landscape.contrast');
  const locale = useLocale();
  return (
    contrast: Contrast,
    self: ProfileVoice,
    competitor: ProfileVoice,
  ): { headline: string; caption: string } => {
    if (locale === DEFAULT_LOCALE) {
      return { headline: contrast.headline, caption: contrast.caption };
    }
    const a = self.brandName;
    const b = competitor.brandName;
    const caption = t('caption', {
      name: b,
      mentions: competitor.keptMentions,
      platforms: competitor.platforms.length,
    });
    if (self.sentiment && competitor.sentiment) {
      const aPct = self.sentiment.positivePct;
      const bPct = competitor.sentiment.positivePct;
      const delta = aPct - bPct;
      const headline =
        Math.abs(delta) < LANDSCAPE_LEVEL_BAND_PCT
          ? t('level', { a, b, aPct, bPct })
          : delta > 0
            ? t('ahead', { a, b, aPct, bPct })
            : t('ahead', { a: b, b: a, aPct: bPct, bPct: aPct });
      return { headline, caption };
    }
    const underSample = [
      self.sentiment ? null : a,
      competitor.sentiment ? null : b,
    ].filter((name): name is string => name !== null);
    const sampleNote =
      underSample.length === 2
        ? t('underSampleTwo', { first: underSample[0], second: underSample[1] })
        : t('underSampleOne', { name: underSample[0] ?? '' });
    return {
      headline: t('unmeasured', { a, b }),
      caption: `${caption} · ${sampleNote}`,
    };
  };
}

/** Contrast lead tone — reuses the report's section pill tones
 * (`section-tone.ts`): ahead=emerald, behind=rose, level=sky, unmeasured=neutral. */
const CONTRAST_TONE: Record<ContrastKind, string> = {
  ahead: sectionTone('voc_desire').pillClass,
  behind: sectionTone('voc_pain').pillClass,
  level: sectionTone('voc_praise').pillClass,
  unmeasured: NEUTRAL_PILL,
};

/** "A, B and C" in the user's language (`Intl.ListFormat`). */
function joinNames(names: string[], locale: string): string {
  if (names.length <= 1) return names[0] ?? '';
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' })
    .format(names)
    // Keep the house style (no serial comma) the English line always used.
    .replace(/, and /, ' and ');
}

export function LandscapeHeadline({
  landscape,
}: {
  landscape: CompetitiveLandscapeResponse;
}) {
  const t = useTranslations('BrandReport.landscape');
  const formatters = useLocaleFormatters();
  const names = landscape.competitors.map((competitor) => competitor.brandName);
  if (names.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className={cn(BI_TYPE.panelTitle, 'text-balance leading-snug sm:text-xl')}>
        {t.rich('headline', {
          count: names.length,
          names: joinNames(names, formatters.locale),
          muted: (chunks) => (
            <span className="font-normal text-muted-foreground">{chunks}</span>
          ),
          b: (chunks) => (
            <b className="font-semibold tabular-nums text-brand-text">
              {chunks}
            </b>
          ),
          list: (chunks) => <span className="break-words">{chunks}</span>,
        })}
      </p>
      <p className={cn(BI_TYPE.meta, 'text-muted-foreground')}>
        {t('caption')}
      </p>
      {isAiTranslatedLandscape(landscape) && <AiTranslatedBadge />}
    </div>
  );
}

export function CompetitiveLandscapePanel({
  landscape,
  treatment = 'classic',
}: {
  landscape: CompetitiveLandscapeResponse;
  treatment?: ReportTreatment;
}) {
  const contrastCopy = useContrastCopy();
  const contrastById = new Map(
    landscape.contrasts.map((contrast) => [contrast.competitorId, contrast]),
  );
  return (
    <div className="space-y-4" data-treatment={treatment}>
      {landscape.competitors.map((competitor) => {
        const contrast = contrastById.get(competitor.profileId) ?? null;
        const copy = contrast
          ? contrastCopy(contrast, landscape.self, competitor)
          : null;
        return (
          <article
            key={competitor.profileId}
            className="glass-surface min-w-0 space-y-4 p-4 sm:p-5"
          >
            <header className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className={cn(BI_TYPE.cardTitle, 'min-w-0 break-words')}>
                  {competitor.brandName}
                </h3>
                <PresenceRoleBadge role="competitor" />
              </div>
              {contrast && copy && (
                <div
                  className={cn(
                    'rounded-xl border px-3.5 py-3',
                    CONTRAST_TONE[contrast.kind],
                  )}
                >
                  <p className={cn(BI_TYPE.body, 'text-balance font-semibold')}>
                    {copy.headline}
                  </p>
                  <p className={cn(BI_TYPE.meta, 'mt-1 opacity-80')}>
                    {copy.caption}
                  </p>
                </div>
              )}
            </header>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <LandscapeVoiceColumn voice={landscape.self} role="self" />
              <LandscapeVoiceColumn voice={competitor} role="competitor" />
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function LandscapeVoiceColumn({
  voice,
  role,
}: {
  voice: ProfileVoice;
  role: 'self' | 'competitor';
}) {
  const t = useTranslations('BrandReport.landscape');
  const formatters = useLocaleFormatters();
  return (
    <section
      aria-label={voice.brandName}
      className="min-w-0 space-y-3 rounded-xl border border-border p-3.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className={cn(BI_TYPE.cardTitle, 'min-w-0 break-words')}>
          {voice.brandName}
        </p>
        <PresenceRoleBadge role={role} />
      </div>

      {voice.keptMentions === 0 ? (
        <p className={cn(BI_TYPE.meta, 'text-muted-foreground')}>
          {t('notListening')}
        </p>
      ) : (
        <>
          <SentimentBar sentiment={voice.sentiment} />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn(BI_TYPE.meta, 'mr-1 tabular-nums text-muted-foreground')}>
              {t.rich('keptMentions', {
                count: voice.keptMentions,
                b: (chunks) => (
                  <b className="font-semibold text-foreground">{chunks}</b>
                ),
              })}
            </span>
            {voice.platforms.map((row) => (
              <span
                key={row.platform}
                className="glass-pill px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"
              >
                {channelLabel(row.platform)} {formatters.integer(row.kept)}
              </span>
            ))}
          </div>
          <ThemeLists themesByKind={voice.themesByKind} />
          {voice.topPraise && (
            <LandscapeQuoteBlock label={t('topPraise')} quote={voice.topPraise} />
          )}
          {voice.topComplaint && (
            <LandscapeQuoteBlock
              label={t('topComplaint')}
              quote={voice.topComplaint}
            />
          )}
          {voice.hookQuotes.length > 0 && (
            <div className="space-y-1.5">
              <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
                {t('hookWorthy')}
              </p>
              <ul className="space-y-1">
                {voice.hookQuotes.map((quote, index) => (
                  <li
                    key={`${index}-${quote}`}
                    className={cn(BI_TYPE.meta, 'break-words italic text-muted-foreground')}
                  >
                    “{quote}”
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SentimentBar({ sentiment }: { sentiment: ProfileVoice['sentiment'] }) {
  const t = useTranslations('BrandReport.landscape');
  const tSentiment = useTranslations('BrandReport.landscape.sentiment');
  if (!sentiment) {
    return (
      <p className={cn(BI_TYPE.meta, 'text-muted-foreground')}>
        {t('sentimentUnmeasured', { min: LANDSCAPE_MIN_SAMPLE })}
      </p>
    );
  }
  const segments = [
    { key: 'positive', pct: sentiment.positivePct, barClass: 'bg-emerald-500' },
    { key: 'neutral', pct: sentiment.neutralPct, barClass: 'bg-slate-300 dark:bg-slate-600' },
    { key: 'negative', pct: sentiment.negativePct, barClass: 'bg-rose-500' },
  ] as const;
  return (
    <div className="space-y-1.5">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted/40"
        aria-hidden="true"
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            className={cn('block h-2', segment.barClass)}
            style={{ width: `${segment.pct}%` }}
          />
        ))}
      </div>
      <p className={cn(BI_TYPE.meta, 'flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums text-muted-foreground')}>
        {segments.map((segment) => (
          <span key={segment.key}>
            {tSentiment(segment.key, { pct: segment.pct })}
          </span>
        ))}
      </p>
    </div>
  );
}

function ThemeLists({
  themesByKind,
}: {
  themesByKind: ProfileVoice['themesByKind'];
}) {
  const kindTitle = useVocKindTitle();
  const formatters = useLocaleFormatters();
  const kinds = THEME_KIND_ORDER.filter(
    ({ kind }) => (themesByKind[kind]?.length ?? 0) > 0,
  );
  if (kinds.length === 0) return null;
  return (
    <div className="space-y-2.5">
      {kinds.map(({ kind, section, dotClass }) => (
        <div key={kind} className="space-y-1">
          <p className={cn(BI_TYPE.eyebrow, 'flex items-center gap-1.5 text-muted-foreground')}>
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', dotClass)} />
            {kindTitle(section)}
          </p>
          <ul>
            {themesByKind[kind].map((theme) => (
              <li
                key={`${kind}-${landscapeThemeKey(theme)}`}
                className={cn(
                  BI_TYPE.meta,
                  'flex items-baseline gap-2 border-t border-border py-1 first:border-t-0',
                )}
              >
                <span className="min-w-0 break-words">{theme.label}</span>
                <span className="ml-auto shrink-0 font-semibold tabular-nums text-brand-text">
                  {formatters.integer(theme.mentionCount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function LandscapeQuoteBlock({
  label,
  quote,
}: {
  label: string;
  quote: LandscapeQuote;
}) {
  const t = useTranslations('BrandReport.landscape');
  const formatters = useLocaleFormatters();
  return (
    <figure className="space-y-1">
      <figcaption className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
        {label}
      </figcaption>
      <blockquote className="border-l-2 border-brand/30 pl-3">
        <p className={cn(BI_TYPE.body, 'line-clamp-4 break-words italic leading-relaxed')}>
          “{quote.body}”
        </p>
        <footer className={cn(BI_TYPE.meta, 'mt-1 flex flex-wrap items-center gap-2 text-muted-foreground')}>
          <span>{channelLabel(quote.platform)}</span>
          {quote.rating != null && (
            <span className="inline-flex items-center gap-0.5 font-semibold text-amber-600 dark:text-amber-400">
              <Star className="h-3 w-3 fill-current" aria-hidden="true" />
              {formatters.decimal(Number(quote.rating), 1)}
            </span>
          )}
          {quote.url && (
            <a
              href={quote.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 font-semibold text-brand-text hover:underline"
            >
              {t('source')}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
        </footer>
      </blockquote>
    </figure>
  );
}

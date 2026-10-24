'use client';

/**
 * Chapter 02 — "The Narrative". The AI Brand Narrative rendered on a
 * panel-frost surface: a FIGURE BAND, headline, story, and grounded
 * strengths/tensions. Classic shows the full narrative and finding columns;
 * distilled leads with numbered takeaways split into two headed columns —
 * what's working and tensions to resolve, the point alone, no cited sub-lines
 * — above the always-visible narrative. `watchItems`/`hypotheses`
 * stay off the chapter: they are model-only observations, never approvable.
 * The LLM never sourced a number — it narrates the deterministic facts the
 * chapters below display. Generation is explicit (one gated LLM call,
 * server-side cooldown + cap).
 *
 * The band and the inline highlights are a pure re-presentation of numbers the
 * findings already carry (`narrative-figures.ts`): the chapter's problem was
 * that every figure it cites was buried mid-sentence with nothing for the eye
 * to land on. Nothing here sources or reformats a number.
 */
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { FrostPanel } from '@/components/ui/frost-panel';
import { AiTranslatedBadge } from '@/components/i18n/AiTranslatedBadge';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  BrandSynthesis,
  BrandSynthesisStaleness,
} from '@/lib/brand-object/synthesis/types';
import type { ReportTreatment } from '@/lib/brand-object/insights';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';

import { parseEvidenceItems } from './narrative-evidence';
import {
  FIGURE_BAND_MIN,
  figureBand,
  figureTones,
  narrativeFigures,
  splitStoryFigures,
  type FigureTone,
  type NarrativeFigure,
} from './narrative-figures';

export function BrandNarrativePanel({
  synthesis,
  staleness,
  isLoading,
  generating,
  onGenerate,
  treatment = 'classic',
  translated = false,
}: {
  synthesis: BrandSynthesis | null;
  staleness: BrandSynthesisStaleness | null;
  /** The prose is an AI translation of the English narrative (i18n WS4). */
  translated?: boolean;
  isLoading: boolean;
  generating: boolean;
  onGenerate: () => void;
  treatment?: ReportTreatment;
}) {
  const t = useTranslations('BrandReport.narrative');
  if (isLoading) {
    return <Skeleton className="h-56 rounded-3xl" />;
  }

  if (!synthesis) {
    return (
      <FrostPanel contentClassName="items-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {t('emptyPrompt')}
        </p>
        <Button
          size="sm"
          onClick={onGenerate}
          disabled={generating}
          className="gap-2"
        >
          {generating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {t('write')}
        </Button>
      </FrostPanel>
    );
  }

  const figures = narrativeFigures(synthesis);
  const band = figureBand(figures);
  const tones = figureTones(figures);

  const hasTakeaways =
    treatment === 'distilled' &&
    (synthesis.strengths.length > 0 || synthesis.tensions.length > 0);

  return (
    <FrostPanel contentClassName="gap-5 p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className={cn(BI_TYPE.panelTitle, 'max-w-2xl text-balance leading-snug sm:text-xl')}>
            {synthesis.headline}
          </h3>
          {translated && <AiTranslatedBadge />}
        </div>
        {staleness?.stale && staleness.reason === 'facts_changed' && (
          <Button
            variant="outline"
            size="sm"
            onClick={onGenerate}
            disabled={generating}
            className="gap-1.5"
          >
            {generating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {t('regenerate')}
          </Button>
        )}
      </div>

      {band.length >= FIGURE_BAND_MIN && <FigureBand figures={band} />}

      {treatment === 'distilled' ? (
        hasTakeaways ? (
          <>
            <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
              {synthesis.strengths.length > 0 && (
                <TakeawayColumn
                  title={t('working')}
                  tone="strength"
                  findings={synthesis.strengths}
                />
              )}
              {synthesis.tensions.length > 0 && (
                <TakeawayColumn
                  title={t('tensions')}
                  tone="tension"
                  findings={synthesis.tensions}
                />
              )}
            </div>
            <div className="space-y-2">
              <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
                {t('fullStory')}
              </p>
              <StoryParagraphs story={synthesis.story} tones={tones} fullWidth />
            </div>
          </>
        ) : (
          <StoryParagraphs story={synthesis.story} tones={tones} />
        )
      ) : (
        <>
          <StoryParagraphs story={synthesis.story} tones={tones} />

          {(synthesis.strengths.length > 0 ||
            synthesis.tensions.length > 0) && (
            // Stacked for print (data-print-stack): each cited column runs past
            // a sheet, and side by side they can only be cut mid-item by the
            // printer. Stacked, the export breaks between findings instead.
            <div
              className="grid grid-cols-1 gap-3 md:grid-cols-2"
              data-print-stack=""
            >
              {synthesis.strengths.length > 0 && (
                <FindingColumn
                  title={t('working')}
                  tone="strength"
                  findings={synthesis.strengths}
                />
              )}
              {synthesis.tensions.length > 0 && (
                <FindingColumn
                  title={t('tensions')}
                  tone="tension"
                  findings={synthesis.tensions}
                />
              )}
            </div>
          )}
        </>
      )}
    </FrostPanel>
  );
}

/** Figure-tone classes, shared by the band tiles and the inline highlights. */
const FIGURE_TONE: Record<FigureTone | 'neutral', { text: string; tile: string }> = {
  strength: {
    text: 'text-emerald-600 dark:text-emerald-400',
    tile: 'border-emerald-500/25 bg-emerald-500/5 dark:bg-emerald-500/10',
  },
  tension: {
    text: 'text-red-600 dark:text-red-400',
    tile: 'border-red-500/25 bg-red-500/5 dark:bg-red-500/10',
  },
  neutral: {
    text: 'text-brand-text',
    tile: 'border-brand/30 bg-brand-soft',
  },
};

/**
 * The chapter's numbers, lifted out of the prose. Each tile is one finding:
 * the figure it cites, the stream it came down from, and the point it makes.
 */
function FigureBand({ figures }: { figures: NarrativeFigure[] }) {
  return (
    <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {figures.map((figure) => (
        <div
          key={`${figure.tone}-${figure.key}`}
          className={cn(
            'flex h-full flex-col gap-1 rounded-xl border p-3.5',
            FIGURE_TONE[figure.tone].tile,
          )}
        >
          <span
            className={cn(
              'text-2xl font-semibold leading-none tabular-nums',
              FIGURE_TONE[figure.tone].text,
            )}
          >
            {figure.value}
          </span>
          <span className={cn(BI_TYPE.meta, 'leading-snug')}>
            {figure.caption}
          </span>
          {figure.source && (
            <span
              className={cn(BI_TYPE.eyebrow, 'mt-auto pt-1 text-muted-foreground')}
            >
              {figure.source}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function StoryParagraphs({
  story,
  tones,
  fullWidth = false,
}: {
  story: string[];
  /** Figure tone by match key — the story tints the same numbers the band shows. */
  tones: Map<string, FigureTone | 'neutral'>;
  fullWidth?: boolean;
}) {
  return (
    <div className={fullWidth ? 'space-y-3' : 'max-w-3xl space-y-3'}>
      {story.map((paragraph, index) => (
        <p key={index} className={cn(BI_TYPE.body, 'leading-relaxed')}>
          {splitStoryFigures(paragraph, tones).map((segment, position) =>
            segment.kind === 'figure' ? (
              <mark
                key={position}
                className={cn(
                  'rounded bg-transparent px-0.5 font-semibold',
                  FIGURE_TONE[segment.tone].text,
                )}
              >
                {segment.text}
              </mark>
            ) : (
              <span key={position}>{segment.text}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

/** One cited sub-item per line, bold subheading, body text untouched. */
function EvidenceLines({
  evidence,
  className,
}: {
  evidence: string;
  className?: string;
}) {
  const items = parseEvidenceItems(evidence);
  if (items.length === 0) return null;

  return (
    <div className={className}>
      {items.map((item, index) => (
        <p key={index} className="break-words">
          {item.subheading && (
            <span className="font-semibold text-foreground/70">
              {item.subheading}{' '}
            </span>
          )}
          {item.body}
        </p>
      ))}
    </div>
  );
}

/**
 * Distilled takeaways for one tone: a header and the numbered points alone —
 * no cited sub-lines. Numbering restarts per column so each side reads as its
 * own list rather than a continuation of the other.
 */
function TakeawayColumn({
  title,
  tone,
  findings,
}: {
  title: string;
  tone: 'strength' | 'tension';
  findings: Array<{ point: string }>;
}) {
  return (
    <div className="min-w-0 space-y-3">
      <p
        className={cn(
          BI_TYPE.eyebrow,
          tone === 'strength'
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-red-600 dark:text-red-400',
        )}
      >
        {title}
      </p>
      <ul className="space-y-4">
        {findings.map((finding, index) => (
          <li key={index} className="flex items-start gap-2.5">
            <span
              className={cn(
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white',
                tone === 'strength' ? 'bg-emerald-500' : 'bg-red-500',
              )}
            >
              {index + 1}
            </span>
            <p className={cn(BI_TYPE.cardTitle, 'min-w-0 flex-1 leading-snug')}>
              {finding.point}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FindingColumn({
  title,
  tone,
  findings,
}: {
  title: string;
  tone: 'strength' | 'tension';
  findings: Array<{ point: string; evidence: string }>;
}) {
  return (
    <div className="rounded-xl bg-muted/40 p-4">
      <p
        className={cn(
          BI_TYPE.eyebrow,
          tone === 'strength'
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-red-600 dark:text-red-400',
        )}
      >
        {title}
      </p>
      <ul className="mt-2 space-y-2">
        {findings.map((finding, index) => (
          <li key={index} className="flex gap-2 text-xs leading-relaxed">
            <span
              aria-hidden="true"
              className={
                tone === 'strength'
                  ? 'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500'
                  : 'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500'
              }
            />
            <div className="min-w-0 flex-1">
              {finding.point}
              <EvidenceLines
                evidence={finding.evidence}
                className="mt-1 space-y-0.5 text-[11px] text-muted-foreground"
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

'use client';

/**
 * Chapter 03 — "What customers say". The voice-of-customer REPORT: per kind
 * (Pains/Desires/Objections/Praise) rows remain in compareVocRank order and
 * "Show all N" reveals past the display top-K. Classic highlights each lead
 * with its verbatim and keeps platform chips; distilled renders compact labels,
 * frequency bars, and counts while verbatim stays only in the hero pull-quote.
 * Every quote shown here is RANKED, never `evidence[0]` — see
 * `lib/brand-object/voc-verbatim.ts`, and the hero clears a higher bar than a
 * card lead because it is read before any theme context.
 * REPORT-ONLY — findings are presented as evidence, never as approvals.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { BRAND_OBJECT_CONFIG } from '@/lib/brand-object/config';
import type {
  ReportTreatment,
  VocInsightRow,
  VocSection,
} from '@/lib/brand-object/insights';
import {
  MIN_VOC_HERO_SCORE,
  scoreVocVerbatim,
} from '@/lib/brand-object/voc-verbatim';
import type { BrandBuildProgress } from '@/hooks/brand-object/useBrandObject';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';
import { useVocKindTitle } from './report-copy';

const KIND_CONFIG: Record<
  VocSection,
  { title: string; dotClass: string; leadClass: string; barClass: string }
> = {
  voc_pain: {
    title: 'Pains',
    dotClass: 'bg-rose-500',
    leadClass: 'bg-rose-500/10 dark:bg-rose-500/15',
    barClass: 'bg-rose-500',
  },
  voc_desire: {
    title: 'Desires',
    dotClass: 'bg-emerald-500',
    leadClass: 'bg-emerald-500/10 dark:bg-emerald-500/15',
    barClass: 'bg-emerald-500',
  },
  voc_objection: {
    title: 'Objections',
    dotClass: 'bg-amber-500',
    leadClass: 'bg-amber-500/10 dark:bg-amber-500/15',
    barClass: 'bg-amber-500',
  },
  voc_praise: {
    title: 'Praise',
    dotClass: 'bg-sky-500',
    leadClass: 'bg-sky-500/10 dark:bg-sky-500/15',
    barClass: 'bg-sky-500',
  },
};

/**
 * Reading order, and the polarity split the two columns render. What customers
 * WANT and PRAISE reads down the left; what hurts and what blocks reads down
 * the right — so a glance separates the good news from the work, instead of
 * alternating green/red across the grid.
 */
const POSITIVE_KINDS: VocSection[] = ['voc_desire', 'voc_praise'];
const NEGATIVE_KINDS: VocSection[] = ['voc_pain', 'voc_objection'];
const KIND_ORDER: VocSection[] = [...POSITIVE_KINDS, ...NEGATIVE_KINDS];

/**
 * The chapter headline quote: still the most-mentioned theme among the ones the
 * chapter shows unexpanded, but now the most-mentioned theme whose quote is
 * WORTH PRINTING. Picking the biggest theme's first stored quote headlined
 * Magic Spoon's chapter with “Magic spoon” (122-mention "Liked the flavor"), so
 * a theme is skipped when its best verbatim can't clear the hero bar, and a
 * chapter whose every quote is a fragment shows no headline at all.
 */
function pickHeroRow(
  sections: VocSection[],
  rowsBySection: Partial<Record<VocSection, VocInsightRow[]>>,
): VocInsightRow | null {
  const ranked = sections
    .flatMap((section) =>
      (rowsBySection[section] ?? []).slice(
        0,
        BRAND_OBJECT_CONFIG.insights.vocDisplayTopK,
      ),
    )
    .map((row) => ({
      row,
      score: row.verbatim ? scoreVocVerbatim(row.verbatim, row.label) : 0,
    }))
    .filter((entry) => entry.score > MIN_VOC_HERO_SCORE)
    .sort((a, b) => b.row.frequency - a.row.frequency || b.score - a.score);
  return ranked[0]?.row ?? null;
}

export function VocReportPanel({
  rowsBySection,
  listening,
  building = false,
  treatment = 'classic',
}: {
  /** ALL rows per section, already in compareVocRank order. */
  rowsBySection: Partial<Record<VocSection, VocInsightRow[]>>;
  /** Live listening aggregates (objectStatus.progress.listening) — lets the
   * empty state distinguish "no sources connected" from "data collected,
   * distillation pending". */
  listening?: BrandBuildProgress['listening'] | null;
  building?: boolean;
  treatment?: ReportTreatment;
}) {
  const t = useTranslations('BrandReport.voc');
  const kindTitle = useVocKindTitle();
  const sections = KIND_ORDER.filter(
    (section) => (rowsBySection[section]?.length ?? 0) > 0,
  );
  if (sections.length === 0) {
    const keptMentions = listening?.keptMentions ?? 0;
    const listeningActive =
      building ||
      (listening?.activeJobs ?? 0) > 0 ||
      (listening?.activeSources ?? 0) > 0;
    return (
      <div className="rounded-xl border border-dashed border-border/70 p-8 text-center">
        {keptMentions > 0 ? (
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            {listeningActive && (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            )}
            <span>
              {t.rich('distilling', {
                count: keptMentions,
                // Raw count, as before (pinned by the empty-state test).
                value: String(keptMentions),
                b: (chunks) => <b className="text-foreground">{chunks}</b>,
              })}
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('empty')}
          </p>
        )}
      </div>
    );
  }

  const leadQuote = pickHeroRow(sections, rowsBySection);

  return (
    <div className="space-y-4">
      {leadQuote && (
        <blockquote className="border-l-2 border-brand/30 pl-4">
          <p className="text-balance text-base italic leading-relaxed sm:text-lg">
            “{leadQuote.verbatim}”
          </p>
          <footer className={cn(BI_TYPE.meta, 'mt-1.5 flex flex-wrap items-center gap-2 text-muted-foreground')}>
            <span>
              {t('heroMeta', {
                kind: kindTitle(leadQuote.section),
                label: leadQuote.label,
                count: leadQuote.frequency,
              })}
            </span>
            <PlatformChips row={leadQuote} />
          </footer>
        </blockquote>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {([
          ['positive', POSITIVE_KINDS],
          ['negative', NEGATIVE_KINDS],
        ] as const).map(([polarity, kinds]) => {
          const columnSections = sections.filter((section) =>
            kinds.includes(section),
          );
          if (columnSections.length === 0) return null;
          return (
            <div key={polarity} className="min-w-0 space-y-4">
              {columnSections.map((section) => (
                <VocKindCard
                  key={section}
                  section={section}
                  rows={rowsBySection[section] ?? []}
                  treatment={treatment}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VocKindCard({
  section,
  rows,
  treatment = 'classic',
}: {
  section: VocSection;
  rows: VocInsightRow[];
  treatment?: ReportTreatment;
}) {
  const t = useTranslations('BrandReport.voc');
  const kindTitle = useVocKindTitle();
  const [showAll, setShowAll] = useState(false);
  const config = KIND_CONFIG[section];
  const topK = BRAND_OBJECT_CONFIG.insights.vocDisplayTopK;
  const [lead, ...rest] = rows;
  const visibleRest = showAll ? rest : rest.slice(0, Math.max(0, topK - 1));
  const totalMentions = rows.reduce((sum, row) => sum + row.frequency, 0);

  return (
    <div className="glass-surface space-y-1 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2 pb-1">
        <span
          aria-hidden="true"
          className={cn('h-2 w-2 rounded-full', config.dotClass)}
        />
        <h3 className={BI_TYPE.cardTitle}>{kindTitle(section)}</h3>
        <span className={cn(BI_TYPE.meta, 'ml-auto tabular-nums text-muted-foreground')}>
          {t('cardMeta', { themes: rows.length, mentions: totalMentions })}
        </span>
      </div>

      {treatment === 'distilled' ? (
        <DistilledVocRows
          lead={lead}
          rest={visibleRest}
          barClass={config.barClass}
        />
      ) : (
        <>
          {lead && (
            <div className={cn('rounded-xl px-3.5 py-3', config.leadClass)}>
              <div className="flex flex-wrap items-baseline gap-2">
                <p className={BI_TYPE.cardTitle}>{lead.label}</p>
                <span className={cn(BI_TYPE.meta, 'tabular-nums text-muted-foreground')}>
                  {t('mentions', { count: lead.frequency })}
                </span>
                <PlatformChips row={lead} />
              </div>
              {lead.verbatim && (
                <p className={cn(BI_TYPE.body, 'mt-1.5 break-words italic text-muted-foreground')}>
                  “{lead.verbatim}”
                </p>
              )}
            </div>
          )}

          {visibleRest.map((row) => (
            <div
              key={row.factId}
              className={cn(
                BI_TYPE.meta,
                'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-border py-2 first:border-t-0',
              )}
            >
              <span className="min-w-0 break-words">{row.label}</span>
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold tabular-nums text-brand-text">
                  {row.frequency}
                </span>
                <PlatformChips row={row} />
              </span>
            </div>
          ))}
        </>
      )}

      {rest.length > Math.max(0, topK - 1) && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className={cn(BI_TYPE.meta, 'pt-1 font-semibold text-brand-text hover:underline')}
        >
          {showAll ? t('showTop') : t('showAll', { count: rows.length })}
        </button>
      )}
    </div>
  );
}

function DistilledVocRows({
  lead,
  rest,
  barClass,
}: {
  lead: VocInsightRow | undefined;
  rest: VocInsightRow[];
  barClass: string;
}) {
  const rows = lead ? [lead, ...rest] : rest;
  const leadFrequency = lead?.frequency ?? 0;

  return rows.map((row, index) => (
    <div
      key={row.factId}
      className={cn(
        BI_TYPE.meta,
        'grid grid-cols-[minmax(0,1fr)_64px_38px] items-center gap-2 border-t border-border py-1.5 first:border-t-0',
      )}
    >
      <span
        className={cn(
          'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap',
          index === 0 && 'font-semibold',
        )}
      >
        {row.label}
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-muted/40">
        <span
          className={cn('block h-1 rounded-full', barClass)}
          style={{
            width: `${
              leadFrequency > 0
                ? Math.round((row.frequency / leadFrequency) * 100)
                : 0
            }%`,
          }}
        />
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground">
        {row.frequency}
      </span>
    </div>
  ));
}

function PlatformChips({ row }: { row: VocInsightRow }) {
  if (row.platforms.length === 0) return null;
  return (
    <span className="glass-pill px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
      {row.platforms
        .map((entry) => `${entry.platform.replace(/_/g, ' ')} ${entry.count}`)
        .join(' · ')}
    </span>
  );
}

'use client';

/**
 * Chapter 05 — "How it all lines up". The one chapter that reads ACROSS the
 * streams instead of down one of them: your claims (01) beside what customers
 * say (03) beside the angles you run beside what the market rewards (04), each
 * node carrying whether it meets anything on the other side.
 *
 * Four columns on desktop (two on tablet, stacked on mobile) — "Your angles"
 * and "Winning angles" are a matched pair, so the founder reads the overlap
 * between what they run and what wins directly. The relationship lives on the
 * NODE ("A claim answers this", plus the counterpart's name) rather than in
 * drawn connectors, so the map reads identically at 375px and never needs a
 * line to survive a reflow. Status is carried twice, in border style and in
 * words, so it doesn't rest on color alone. A deterministic "What to do next"
 * block under the map distills the columns into ranked next steps.
 *
 * Matching is deterministic (`lib/brand-object/alignment.ts`): word overlap
 * between the claims and voice columns, and exact angle-tag equality against
 * the brand's own labeled ads in the market column. The chapter header is
 * owned by the dashboard, and the whole section unmounts when there is nothing
 * to align.
 */
import { useTranslations } from 'next-intl';
import type {
  AlignmentNode,
  AlignmentStatus,
  AlignmentSuggestion,
  BrandAlignment,
} from '@/lib/brand-object/alignment';
import type { ReportTreatment } from '@/lib/brand-object/insights';
import { INSIGHT_LINKS } from '@/lib/brand-object/insights';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useAlignmentCopy } from './alignment-copy';

const STATUS_STYLE: Record<AlignmentStatus, { card: string; note: string }> = {
  aligned: {
    card: 'border-emerald-500/40 bg-emerald-500/5 dark:bg-emerald-500/10',
    note: 'text-emerald-600 dark:text-emerald-400',
  },
  claimed: {
    card: 'border-dashed border-amber-500/40 bg-amber-500/5 dark:bg-amber-500/10',
    note: 'text-amber-600 dark:text-amber-400',
  },
  gap: {
    card: 'border-dashed border-red-500/40 bg-red-500/5 dark:bg-red-500/10',
    note: 'text-red-600 dark:text-red-400',
  },
  silent: {
    card: 'border-dashed border-border/70',
    note: 'text-muted-foreground',
  },
};

// Four columns, read left to right: what you say, what customers say, the
// angles you actually run, and the angles the market rewards. The last two are
// a matched pair — "Your angles" and "Winning angles" carry message angles
// only (hook/format/offer are craft, not argument), so a founder can scan the
// overlap between what they run and what wins in one glance.
const COLUMNS = [
  { key: 'claims', heading: 'claimsHeading', empty: 'nothingYet' },
  { key: 'voice', heading: 'voiceHeading', empty: 'nothingYet' },
  // When empty, each of the paired columns names its own blocker rather than
  // the generic "nothing distilled" — the founder needs to know WHAT to
  // connect/run, not that a column happens to be empty. "Winning angles" also
  // links straight to the page that fills it.
  {
    key: 'ownAdvertised',
    heading: 'ownHeading',
    empty: 'ownEmpty',
  },
  {
    key: 'market',
    heading: 'marketHeading',
    empty: 'marketEmpty',
    emptyHref: INSIGHT_LINKS.market,
  },
] as const;

// Each suggestion's accent — and the word printed beside it, so the kind never
// rests on color alone.
const SUGGESTION_META: Record<
  AlignmentSuggestion['kind'],
  { label: 'opportunity' | 'friction' | 'strength'; dot: string; text: string }
> = {
  opportunity: {
    label: 'opportunity',
    dot: 'bg-brand',
    text: 'text-brand-text',
  },
  friction: {
    label: 'friction',
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
  },
  strength: {
    label: 'strength',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
};

const LEGEND: AlignmentStatus[] = ['aligned', 'claimed', 'gap', 'silent'];

/**
 * Chapter 05's one-line takeaway, rendered by the dashboard above the panel —
 * the alignment rate up front, the single biggest unrun opportunity beside it.
 * Deterministic: both figures are counts the map already shows.
 */
export function AlignmentHeadline({
  summary,
}: {
  summary: BrandAlignment['summary'];
}) {
  const t = useTranslations('BrandReport.alignment');
  if (summary.totalClaims === 0) return null;
  const muted = (chunks: React.ReactNode) => (
    <span className="font-normal text-muted-foreground">{chunks}</span>
  );
  return (
    <p className={cn(BI_TYPE.panelTitle, 'text-balance leading-snug sm:text-xl')}>
      {t.rich('headline', {
        echoed: summary.echoedClaims,
        total: summary.totalClaims,
        b: (chunks) => (
          <b className="font-semibold text-brand-text tabular-nums">
            {chunks}
          </b>
        ),
        muted,
      })}
      {summary.unadvertisedAngles > 0 &&
        t.rich('headlineUnadvertised', {
          count: summary.unadvertisedAngles,
          red: (chunks) => (
            <b className="font-semibold tabular-nums text-red-600 dark:text-red-400">
              {chunks}
            </b>
          ),
          muted,
        })}
    </p>
  );
}

export function AlignmentMapPanel({
  alignment,
  treatment = 'classic',
}: {
  alignment: BrandAlignment;
  treatment?: ReportTreatment;
}) {
  // Both treatments share the map; `treatment` is kept for parity with the
  // other chapters and future divergence.
  void treatment;
  const t = useTranslations('BrandReport.alignment');
  const tLegend = useTranslations('BrandReport.alignment.legend');
  const tKind = useTranslations('BrandReport.alignment.suggestionKinds');
  const copy = useAlignmentCopy();

  return (
    <div className="section-frost">
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {COLUMNS.map((column) => {
            const nodes = alignment[column.key];
            // "Winning angles" is blocked not only when it is empty but also
            // when its cards carry no verdict — with no labeled own ads, every
            // market card reads "no labeled ads to compare yet", so we hide the
            // cards and name the blocker (and link straight to the fix) instead.
            const blocked =
              nodes.length === 0 ||
              (column.key === 'market' &&
                alignment.summary.ownAdsLabeled === 0);
            const emptyHref =
              'emptyHref' in column ? column.emptyHref : undefined;
            return (
              <div key={column.key} className="space-y-2">
                <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
                  {t(column.heading)}
                </p>
                {blocked ? (
                  <p
                    className={cn(
                      BI_TYPE.meta,
                      'rounded-lg bg-muted/40 p-3 text-muted-foreground',
                    )}
                  >
                    {emptyHref ? (
                      <Link
                        href={emptyHref}
                        className="font-medium text-brand-text hover:underline"
                      >
                        {t(column.empty)}
                      </Link>
                    ) : (
                      t(column.empty)
                    )}
                  </p>
                ) : (
                  nodes.map((node) => (
                    <AlignmentCard key={node.id} node={node} />
                  ))
                )}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border/60 pt-4">
          {LEGEND.map((status) => (
            <span
              key={status}
              className={cn(
                BI_TYPE.meta,
                'flex items-center gap-2 text-muted-foreground',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-3 w-5 shrink-0 rounded border',
                  STATUS_STYLE[status].card,
                )}
              />
              {tLegend(status)}
            </span>
          ))}
        </div>

        {/* What to do — deterministic next steps distilled from the columns
            above. Every line is a template over the same nodes; the map sources
            the numbers, this block only tells the founder where to act first. */}
        {alignment.suggestions.length > 0 && (
          <div className="space-y-3 rounded-xl border border-border/60 bg-background/50 p-4">
            <p className={cn(BI_TYPE.eyebrow, 'text-muted-foreground')}>
              {t('nextSteps')}
            </p>
            <ul className="space-y-2.5">
              {alignment.suggestions.map((suggestion) => {
                const meta = SUGGESTION_META[suggestion.kind];
                return (
                  <li key={suggestion.id} className="flex gap-2.5">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full',
                        meta.dot,
                      )}
                    />
                    <p className={cn(BI_TYPE.body, 'leading-relaxed')}>
                      <span
                        className={cn(BI_TYPE.eyebrow, 'mr-2 align-baseline', meta.text)}
                      >
                        {tKind(meta.label)}
                      </span>
                      {copy.suggestion(suggestion)}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function AlignmentCard({ node }: { node: AlignmentNode }) {
  const copy = useAlignmentCopy();
  const style = STATUS_STYLE[node.status];
  const detail = copy.detail(node);
  return (
    <div className={cn('space-y-1.5 rounded-xl border p-3', style.card)}>
      {detail && (
        <span className={cn(BI_TYPE.eyebrow, 'block text-muted-foreground')}>
          {detail}
        </span>
      )}
      <p className={cn(BI_TYPE.cardTitle, 'break-words leading-snug')}>
        {node.label}
      </p>
      <p className={cn(BI_TYPE.meta, 'font-medium', style.note)}>
        {copy.note(node)}
      </p>
      {node.links.length > 0 && (
        <p className={cn(BI_TYPE.meta, 'break-words text-muted-foreground')}>
          {node.links.join(' · ')}
        </p>
      )}
    </div>
  );
}

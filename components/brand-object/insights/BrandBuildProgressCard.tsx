'use client';

/**
 * Unified "building your report" progress card for the Brand Identity report
 * page. Three tracks — competitor ad analysis, customer listening, and the
 * Layer-3 build chain — fed by ONE already-polling read
 * (`useBrandObjectStatus`'s `progress` aggregates + `activeJobs`). Pure
 * display; the page decides when to mount it (no facts yet, or anything
 * still active). Composed from the shared frost primitives only.
 */
import type { LucideIcon } from 'lucide-react';
import { CheckCircle2, Ear, Loader2, Radar, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { FrostPanel } from '@/components/ui/frost-panel';
import { Progress } from '@/components/ui/progress';
import { BI_TYPE } from '@/components/brand-identity/typography';
import type { BrandObjectStatusView } from '@/hooks/brand-object/useBrandObject';
import { BRAND_OBJECT_JOB_TYPES } from '@/services/job-processor/brand-object/types';

/** Build job type → `BrandReport.buildProgress.stages` key. */
const STAGE_KEYS = {
  brand_object_crawl: 'crawl',
  brand_object_identity: 'identity',
  brand_object_promote: 'promote',
  brand_object_market: 'market',
  brand_object_personas: 'personas',
  brand_object_chunks: 'chunks',
} as const;

function TrackRow({
  icon: Icon,
  title,
  detail,
  active,
  done,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  active: boolean;
  done: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-brand-text" />
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="ml-auto shrink-0">
          {active ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-text motion-reduce:animate-none" />
          ) : done ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : null}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{detail}</p>
      {children}
    </div>
  );
}

export function BrandBuildProgressCard({
  status,
}: {
  status: BrandObjectStatusView | null;
}) {
  const t = useTranslations('BrandReport.buildProgress');
  const tStage = useTranslations('BrandReport.buildProgress.stages');
  const progress = status?.progress;
  const activeJobs = status?.activeJobs ?? [];
  const state = status?.state ?? null;

  // Competitor track
  const tagged = progress?.competitors.tagged ?? 0;
  const synced = progress?.competitors.synced ?? 0;
  const syncing = progress?.competitors.syncing ?? 0;
  const competitorsDone = tagged > 0 && synced >= tagged && syncing === 0;
  const competitorDetail =
    tagged === 0
      ? t('competitorsNone')
      : t('competitorsScraped', { synced, tagged });

  // Listening track
  const keptMentions = progress?.listening.keptMentions ?? 0;
  const listeningActive =
    (progress?.listening.activeJobs ?? 0) > 0 ||
    (progress?.listening.activeSources ?? 0) > 0;
  const listeningDetail = listeningActive
    ? t('listeningActive', { count: keptMentions })
    : keptMentions > 0
      ? t('listeningDone', { count: keptMentions })
      : t('listeningPending');

  // Build track — first active stage against the ordered chain.
  const activeTypes = new Set(activeJobs.map((job) => job.type));
  const stageIndex = BRAND_OBJECT_JOB_TYPES.findIndex((type) =>
    activeTypes.has(type),
  );
  const buildActive = activeJobs.length > 0;
  const completenessPct =
    state && 'overall' in state.completeness
      ? Math.round(((state.completeness.overall as number) ?? 0) * 100)
      : null;
  const buildDone = !buildActive && state != null && completenessPct != null;
  const buildDetail = buildActive
    ? stageIndex >= 0
      ? t('buildStage', {
          stage: stageIndex + 1,
          total: BRAND_OBJECT_JOB_TYPES.length,
          label:
            BRAND_OBJECT_JOB_TYPES[stageIndex] in STAGE_KEYS
              ? tStage(
                  STAGE_KEYS[
                    BRAND_OBJECT_JOB_TYPES[stageIndex] as keyof typeof STAGE_KEYS
                  ],
                )
              : BRAND_OBJECT_JOB_TYPES[stageIndex],
        })
      : t('buildQueued')
    : buildDone
      ? t('buildDone', { pct: completenessPct ?? 0 })
      : t('buildNotStarted');

  return (
    <FrostPanel contentClassName="gap-4 p-6 sm:p-8">
      <div className="space-y-1">
        <h2 className={BI_TYPE.panelTitle}>
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2">
        <TrackRow
          icon={Radar}
          title={t('competitorTrack')}
          detail={competitorDetail}
          active={syncing > 0}
          done={competitorsDone}
        >
          {tagged > 0 && (
            <Progress
              value={Math.round((synced / tagged) * 100)}
              aria-label={t('competitorProgressAria')}
            />
          )}
        </TrackRow>
        <TrackRow
          icon={Ear}
          title={t('listeningTrack')}
          detail={listeningDetail}
          active={listeningActive}
          done={!listeningActive && keptMentions > 0}
        />
        <TrackRow
          icon={Sparkles}
          title={t('buildTrack')}
          detail={buildDetail}
          active={buildActive}
          done={buildDone}
        >
          {buildActive ? (
            <Progress
              value={
                stageIndex >= 0
                  ? Math.round(
                      (stageIndex / BRAND_OBJECT_JOB_TYPES.length) * 100,
                    )
                  : 5
              }
              aria-label={t('buildProgressAria')}
            />
          ) : completenessPct != null ? (
            <Progress
              value={completenessPct}
              aria-label={t('coverageAria')}
            />
          ) : null}
        </TrackRow>
      </div>
    </FrostPanel>
  );
}

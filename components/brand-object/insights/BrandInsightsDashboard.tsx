'use client';

/**
 * The Brand Identity report — ONE editorial dashboard using the "Editorial
 * spread" (Variation C): a sticky identity rail beside a numbered evidence
 * stream covering identity → AI narrative → customer voice → market playbook
 * → alignment → personas → own-ad performance → competitive landscape. Alignment sits at 05 because it is the only chapter
 * that reads ACROSS streams: it cannot be understood until 01, 03 and 04 have
 * each been read on their own terms. A deterministic render of live facts
 * (market_prior = distilled competitor analysis, voc_* = distilled brand
 * presence) plus thin live
 * L1/L2 headline stats; the ONLY LLM output on the page is the narrative
 * chapter, generated explicitly and grounded in the same facts. REPORT-ONLY:
 * no approval controls anywhere — facts come down as props from the page's
 * existing useBrandFacts read, and every chapter degrades per-stream (an
 * empty or errored stream shows its unlock CTA, never blanks the report).
 * The two CONDITIONAL tail chapters — own-ad performance ("What's working
 * for you", only with labeled own-ad spend) then the competitive landscape
 * (only when the org listens to a Brand Presence competitor with kept
 * mentions) — sit last and take their numbers from `tailChapterNumbers`, the
 * same helper the rail's jump list reads, so an absent one leaves no gap. An
 * empty or unavailable read hides a tail chapter, never an error state.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  BrandFactView,
  BrandObjectStatusView,
} from '@/hooks/brand-object/useBrandObject';
import {
  useBrandSynthesis,
  useOwnAdAngles,
  useRunBrandSynthesis,
} from '@/hooks/brand-object/useBrandObject';
import { useBrandPresenceSources } from '@/hooks/brand-presence/use-brand-presence/sources';
import { useCompetitiveLandscape } from '@/hooks/brand-presence/useCompetitiveLandscape';
import { useOwnPerformance } from '@/hooks/brand-object/useOwnPerformance';
import { useCompetitors } from '@/hooks/brand-identity/useCompetitors';
import { useBrandIdentityScope } from '@/hooks/brand-object/useBrandIdentityScope';
import { useLocaleFormatters } from '@/hooks/useLocaleFormatters';
import { useLocalizeError } from '@/lib/i18n/localize-error';
import { computeScopedStats } from '@/lib/brand-identity/dashboard';
import { brandAlignment } from '@/lib/brand-object/alignment';
import {
  EXAMPLE_BRAND_SYNTHESIS,
  shouldShowExampleAiOverview,
} from '@/lib/demo/example-ai-overview';
import { isBrandIdentityPinnedToBuiltBrand } from '@/lib/brand-object/brand-identity-brand-pin';
import { demoOwnAngleMix } from '@/lib/brand-object/demo-own-angles';
import { effectiveOwnPerformance } from '@/lib/brand-object/demo-own-performance';
import { isOwnPerformanceEmpty } from '@/lib/brand-object/own-performance';
import {
  INSIGHT_LINKS,
  identityClaims,
  marketFormula,
  personaCards,
  priorsByDimension,
  tailChapterNumbers,
  topVocBySection,
  type InsightFact,
  type ReportTreatment,
} from '@/lib/brand-object/insights';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';
import { AlignmentHeadline, AlignmentMapPanel } from './AlignmentMapPanel';
import { BrandNarrativePanel } from './BrandNarrativePanel';
import { ChapterHeader } from './ChapterHeader';
import {
  CompetitiveLandscapePanel,
  LandscapeHeadline,
} from './CompetitiveLandscapePanel';
import { IdentityHeroPanel } from './IdentityHeroPanel';
import { IdentityRail } from './IdentityRail';
import { OwnPerformanceHeadline, OwnPerformancePanel } from './OwnPerformancePanel';
import {
  MarketFormulaHeadline,
  MarketPlaybookPanel,
} from './MarketPlaybookPanel';
import { PersonaLadderHeadline, PersonaStrip } from './PersonaStrip';
import { VocReportPanel } from './VocReportPanel';

function ChapterLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className={cn(BI_TYPE.meta, 'font-semibold text-brand-text hover:underline')}
    >
      {children}
    </Link>
  );
}

export interface BrandInsightsDashboardProps {
  facts: BrandFactView[];
  factsLoading: boolean;
  factsError: boolean;
  objectStatus: BrandObjectStatusView | null;
  brandName?: string | null;
  websiteUrl?: string | null;
  treatment?: ReportTreatment;
}

export function BrandInsightsDashboard({
  facts,
  factsLoading,
  factsError,
  objectStatus,
  brandName = null,
  websiteUrl = null,
  treatment = 'classic',
}: BrandInsightsDashboardProps) {
  const t = useTranslations('BrandReport');
  const formatters = useLocaleFormatters();
  const localizeError = useLocalizeError();
  // Shared-cache hooks — mounting them here dedupes against their home tabs;
  // a loading/errored stat read degrades a caption, never blanks the report.
  const { data: competitors } = useCompetitors();
  const presence = useBrandPresenceSources();
  const synthesis = useBrandSynthesis();
  const runSynthesis = useRunBrandSynthesis();
  // Chapter 05's market column answers "do you make this argument" from the
  // ADS. A loading or errored read leaves the mix null, which reads as "no
  // labeled ads to compare yet" — never as a red.
  const ownAngles = useOwnAdAngles();
  // "What's working for you" — the org's own ads per creative label. Same
  // fail-soft posture: an empty, loading or unavailable read hides the chapter.
  const ownPerformance = useOwnPerformance();
  // The pinned demo orgs report on Magic Spoon, a demo brand with no connected
  // ad account, so `own_ad_labels` is empty and Chapter 05's two right-hand
  // columns can never render. Fabricate the missing own-ad angle mix for those
  // orgs ONLY — never for a real org, whose empty mix is an honest state.
  const { organizationId, selectedProfileId } = useBrandIdentityScope();
  const isPinnedDemoOrg = isBrandIdentityPinnedToBuiltBrand(organizationId);
  // Demo orgs render a polished example narrative and never call the paid route.
  const showExampleAiOverview = shouldShowExampleAiOverview(organizationId);
  // Chapter 07 — competitor voice beside the report brand's. Hidden (not an
  // error) when Brand Presence is unavailable (null) or nobody is compared.
  const landscape = useCompetitiveLandscape({
    organizationId,
    brandProfileId: selectedProfileId,
  });
  const landscapeModel =
    landscape.data && landscape.data.competitors.length > 0
      ? landscape.data
      : null;

  const building =
    (objectStatus?.activeJobs.length ?? 0) > 0 ||
    objectStatus?.state?.status === 'building';

  const models = useMemo(() => {
    const insightFacts = facts as InsightFact[];
    const l1 = competitors
      ? computeScopedStats(competitors, { platform: 'all' })
      : null;
    const keptCount = presence.status.data?.counts?.kept;

    const voc = topVocBySection(insightFacts, Number.POSITIVE_INFINITY);
    const dimensions = priorsByDimension(insightFacts);
    // Chapter 04's headline and chapter 05's alignment read the same formula.
    const market = marketFormula(dimensions);

    // The real mix drives Chapter 05's own-ad columns; a pinned demo org with
    // no labeled own ads (Magic Spoon has no connected account) falls back to a
    // synthetic mix derived from the winning angles so the columns still tell
    // their story. A real org keeps its empty mix and its honest empty state.
    const realOwnMix = ownAngles.data?.mix ?? null;
    const effectiveOwnMix =
      isPinnedDemoOrg && (!realOwnMix || realOwnMix.totalLabeledAds === 0)
        ? demoOwnAngleMix(market)
        : realOwnMix;
    // Same substitution, same gate, for the own-performance chapter — derived
    // from the same winning angles, so its angles agree with Chapter 05's.
    const performance = effectiveOwnPerformance({
      real: ownPerformance.data,
      isPinnedDemoOrg,
      market,
    });

    return {
      positioning: identityClaims(insightFacts, ['positioning'], 1)[0] ?? null,
      pillars: identityClaims(
        insightFacts,
        ['value_prop', 'usp', 'proof_point'],
        6,
      ),
      voice: identityClaims(insightFacts, ['voice'], 6),
      voc,
      dimensions,
      market,
      marketRailClaims: identityClaims(insightFacts, [
        'positioning',
        'usp',
        'value_prop',
      ]),
      // Chapter 05 weighs the SAME claims chapter 01 states against the same
      // voice and market rows chapters 03/04 render — one selector, no
      // second read. `ownAngles` is the one input from outside the facts: the
      // brand's own labeled ads, which is what settles the market column.
      alignment: brandAlignment({
        claims: identityClaims(
          insightFacts,
          ['positioning', 'value_prop', 'usp', 'proof_point'],
          5,
        ),
        voc,
        market,
        ownAngles: effectiveOwnMix,
      }),
      personas: personaCards(insightFacts),
      performance: isOwnPerformanceEmpty(performance) ? null : performance,
      l1,
      mentionsKept: typeof keptCount === 'number' ? keptCount : null,
    };
  }, [
    facts,
    competitors,
    presence.status.data?.counts?.kept,
    ownAngles.data,
    ownPerformance.data,
    isPinnedDemoOrg,
  ]);

  if (factsLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-56 rounded-3xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
    );
  }

  if (factsError) {
    return (
      <div className="rounded-xl border border-rose-200/70 bg-rose-50/50 p-6 text-center dark:border-rose-500/30 dark:bg-rose-950/20">
        <AlertTriangle className="mx-auto h-5 w-5 text-rose-500" />
        <p className="mt-2 text-sm text-rose-700 dark:text-rose-300">
          {t('dashboard.factsError')}
        </p>
      </div>
    );
  }

  const handleGenerate = () =>
    runSynthesis.mutate(
      {},
      {
        onSuccess: (result) => {
          if (result?.status === 'skipped') {
            toast.info(t('dashboard.narrativeSkipped'));
          }
        },
        onError: (error) =>
          toast.error(
            localizeError(error, {
              fallbackKey: 'BrandReport.dashboard.narrativeFailed',
            }),
          ),
      },
    );

  const tailNumbers = tailChapterNumbers({
    hasPerformance: models.performance != null,
    hasLandscape: landscapeModel != null,
  });

  const vocCaption =
    models.mentionsKept != null
      ? t('dashboard.vocCaption', {
          count: formatters.integer(models.mentionsKept),
        })
      : t('dashboard.vocCaptionNoCount');

  return (
    <div className="space-y-10">
      <IdentityRail
        brandName={brandName}
        websiteUrl={websiteUrl}
        positioning={models.positioning}
        voice={models.voice}
        mentionsKept={models.mentionsKept}
        l1={models.l1}
        personaCount={models.personas.length}
        hasAlignment={models.alignment != null}
        hasPerformance={models.performance != null}
        hasLandscape={landscapeModel != null}
      />
      <div className="min-w-0 space-y-10">
        <section id="identity" className="scroll-mt-24 space-y-4">
          <ChapterHeader
            number="01"
            title={t('chapters.identity')}
            action={
              <span className="glass-pill px-2.5 py-0.5 text-[11px] text-muted-foreground">
                {t('dashboard.identityChip')}
              </span>
            }
          />
          <IdentityHeroPanel pillars={models.pillars} treatment={treatment} />
        </section>

        <section id="narrative" className="scroll-mt-24 space-y-4">
          <ChapterHeader
            number="02"
            title={t('chapters.narrative')}
            action={
              <span className="glass-pill px-2.5 py-0.5 text-[11px] text-muted-foreground">
                {t('dashboard.narrativeChip')}
              </span>
            }
          />
          <BrandNarrativePanel
            synthesis={
              showExampleAiOverview
                ? EXAMPLE_BRAND_SYNTHESIS
                : synthesis.data?.synthesis ?? null
            }
            staleness={showExampleAiOverview ? null : synthesis.data?.staleness ?? null}
            translated={showExampleAiOverview ? false : synthesis.data?.translated === true}
            isLoading={showExampleAiOverview ? false : synthesis.isLoading}
            generating={showExampleAiOverview ? false : runSynthesis.isPending}
            onGenerate={showExampleAiOverview ? () => {} : handleGenerate}
            treatment={treatment}
          />
        </section>

        <section id="customers" className="scroll-mt-24 space-y-4">
          <ChapterHeader
            number="03"
            title={t('chapters.customers')}
            action={
              <ChapterLink href={INSIGHT_LINKS.presence}>
                {t('dashboard.fromListening')}
              </ChapterLink>
            }
          />
          <p className={cn(BI_TYPE.meta, 'text-muted-foreground')}>{vocCaption}</p>
          <VocReportPanel
            rowsBySection={models.voc}
            listening={objectStatus?.progress?.listening ?? null}
            building={building}
            treatment={treatment}
          />
        </section>

        <section id="market" className="scroll-mt-24 space-y-4">
          <ChapterHeader
            number="04"
            title={t('chapters.market')}
            action={
              <ChapterLink href={INSIGHT_LINKS.market}>
                {t('dashboard.fromCompetitors')}
              </ChapterLink>
            }
          />
          <MarketFormulaHeadline steps={models.market} />
          <MarketPlaybookPanel
            dimensions={models.dimensions}
            identity={models.marketRailClaims}
            building={building}
            competitors={objectStatus?.progress?.competitors ?? null}
            treatment={treatment}
          />
        </section>

        {models.alignment && (
          <section id="alignment" className="scroll-mt-24 space-y-4">
            <ChapterHeader
              number="05"
              title={t('chapters.alignment')}
              action={
                <span className="glass-pill px-2.5 py-0.5 text-[11px] text-muted-foreground">
                  {t('dashboard.alignmentChip')}
                </span>
              }
            />
            <AlignmentHeadline summary={models.alignment.summary} />
            <AlignmentMapPanel
              alignment={models.alignment}
              treatment={treatment}
            />
          </section>
        )}

        {models.personas.length > 0 && (
          <section id="personas" className="scroll-mt-24 space-y-4">
            <ChapterHeader
              number="06"
              title={t('chapters.personas')}
              action={
                <span className="glass-pill px-2.5 py-0.5 text-[11px] text-muted-foreground">
                  {t('dashboard.personasChip')}
                </span>
              }
            />
            <PersonaLadderHeadline personas={models.personas} />
            <PersonaStrip personas={models.personas} treatment={treatment} />
          </section>
        )}

        {models.performance && tailNumbers.performance && (
          <section id="performance" className="scroll-mt-24 space-y-4">
            <ChapterHeader
              number={tailNumbers.performance}
              title={t('chapters.performance')}
              action={
                <span className="glass-pill px-2.5 py-0.5 text-[11px] text-muted-foreground">
                  {t('dashboard.performanceChip')}
                </span>
              }
            />
            <OwnPerformanceHeadline model={models.performance} />
            <OwnPerformancePanel
              model={models.performance}
              treatment={treatment}
            />
          </section>
        )}

        {landscapeModel && tailNumbers.landscape && (
          <section id="landscape" className="scroll-mt-24 space-y-4">
            <ChapterHeader
              number={tailNumbers.landscape}
              title={t('chapters.landscape')}
              action={
                <ChapterLink href={INSIGHT_LINKS.presence}>
                  {t('dashboard.fromListening')}
                </ChapterLink>
              }
            />
            <LandscapeHeadline landscape={landscapeModel} />
            <CompetitiveLandscapePanel
              landscape={landscapeModel}
              treatment={treatment}
            />
          </section>
        )}
      </div>
    </div>
  );
}

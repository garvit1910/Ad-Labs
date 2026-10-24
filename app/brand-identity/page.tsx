'use client';

/**
 * The Brand Identity page (section root) - Layer 3's founder surface. The
 * internal model keeps its `brand-object` name; this page is its home. ONE
 * editorial report (no review queue - findings are REPORTED, never asked
 * about): just the chaptered BrandInsightsDashboard (identity hero → AI
 * narrative → customer voice → market playbook → personas → guardrails),
 * then the Generate Creatives CTA. The section layout owns the PageHeader
 * and the action row (Manage brands / Export / Build-Refresh, inline with
 * the section nav). A build chain (crawl → identity → promote → market →
 * personas → chunks) runs from that Build button and is polled here while
 * jobs are active. Mobile-first: single column at the base.
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FrostPanel } from '@/components/ui/frost-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { BrandBuildProgressCard } from '@/components/brand-object/insights/BrandBuildProgressCard';
import { BrandInsightsDashboard } from '@/components/brand-object/insights/BrandInsightsDashboard';
import { BI_TYPE } from '@/components/brand-identity/typography';
import { cn } from '@/lib/utils';
import { useOrganization } from '@/contexts/OrganizationContext';
import {
  useBrandBuildSettleRefresh,
  useBrandFacts,
  useBrandObjectStatus,
} from '@/hooks/brand-object/useBrandObject';
import { GenerateCreativesCta } from '@/components/brand-object/insights/GenerateCreativesCta';
import { useBrandIdentityScope } from '@/hooks/brand-object/useBrandIdentityScope';
import { isDistilledReportEnabledForOrg } from '@/lib/brand-object/distilled-report-access';
import { useCreativeStudioEnabled } from '@/hooks/creative-studio/useCreativeStudioEnabled';

export default function BrandIdentityPage() {
  const router = useRouter();
  const t = useTranslations('BrandIdentity.report');
  const { currentOrganization } = useOrganization();
  const distilled = isDistilledReportEnabledForOrg({
    organizationId: currentOrganization?.id,
    organizationName: currentOrganization?.name,
  });
  const scope = useBrandIdentityScope();
  // Studio gate computed HERE and passed down as a boolean so GenerateCreativesCta
  // stays engine-import-free (structural pin).
  const studioEnabled = useCreativeStudioEnabled();
  const status = useBrandObjectStatus({ poll: true });
  const facts = useBrandFacts();
  const state = status.data?.state ?? null;

  // Fill the report in automatically when the build chain settles (facts are
  // otherwise only invalidated on build START).
  useBrandBuildSettleRefresh(status.data);

  const activeJobs = status.data?.activeJobs ?? [];
  const hasFacts = (facts.data?.facts.length ?? 0) > 0;
  const buildProgress = status.data?.progress;
  // "Anything" = build chain, competitor scrapes, or listening still running.
  const anythingActive =
    activeJobs.length > 0 ||
    (buildProgress?.competitors.syncing ?? 0) > 0 ||
    (buildProgress?.listening.activeJobs ?? 0) > 0 ||
    (buildProgress?.listening.activeSources ?? 0) > 0;

  const startSetup = () => router.push('/brand-identity/setup');

  const activeProfile =
    scope.profiles.find((profile) => profile.id === scope.selectedProfileId) ??
    null;
  const activeBrandName = activeProfile?.brand_name ?? null;
  const activeWebsiteUrl = activeProfile?.website_url ?? null;

  if (!scope.isReady && scope.isLoading) {
    return <Skeleton className="h-64 w-full rounded-2xl" />;
  }

  if (!scope.selectedProfileId) {
    return (
      <FrostPanel className="text-center" contentClassName="items-center gap-3 p-8">
        <h2 className={BI_TYPE.panelTitle}>{t('noBrandTitle')}</h2>
        <p className={cn(BI_TYPE.body, 'text-muted-foreground')}>
          {t('noBrandBody')}
        </p>
        <Button size="sm" onClick={startSetup} className="gap-1.5">
          <Sparkles className="h-3.5 w-3.5" />
          {t('setUpBrand')}
        </Button>
      </FrostPanel>
    );
  }

  return (
    <div className="space-y-8">
      {/* No toolbar here - the section layout renders the report's actions
          (Manage brands / Export / Refresh) inline with the section nav row,
          and owns the PageHeader. No review banner either: this page reports
          findings, it doesn't ask for approvals. */}
      {facts.isLoading ? (
        <div className="space-y-6">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-56 rounded-3xl" />
        </div>
      ) : !hasFacts && !facts.isError ? (
        <BrandBuildProgressCard status={status.data ?? null} />
      ) : (
        <>
          {anythingActive && (
            <BrandBuildProgressCard status={status.data ?? null} />
          )}
          <BrandInsightsDashboard
            facts={facts.data?.facts ?? []}
            factsLoading={facts.isLoading}
            factsError={facts.isError}
            objectStatus={status.data ?? null}
            brandName={activeBrandName}
            websiteUrl={activeWebsiteUrl}
            treatment={distilled ? 'distilled' : 'classic'}
          />
        </>
      )}

      <GenerateCreativesCta
        brandReady={state?.status === 'ready'}
        studioEnabled={studioEnabled}
        brandProfileId={scope.selectedProfileId}
      />
    </div>
  );
}

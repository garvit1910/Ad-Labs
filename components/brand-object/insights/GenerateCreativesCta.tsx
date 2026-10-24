'use client';

/**
 * The Brand Identity page's north-star CTA. Wired as a plain NAV deep link to
 * /creative-studio when the org passes the Creative Studio allowlist —
 * generation itself still lives entirely in the studio composer, and this
 * file remains free of lib/creative-engine imports (structural pin:
 * brand-identity-report.structural.test.ts). The gate boolean is computed in
 * the page (which may import the engine's access check) and passed down.
 * Non-allowlisted orgs keep the original disabled "Coming soon" state so the
 * link can never land on the studio's 404.
 */
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { EyebrowChip } from '@/components/ui/eyebrow-chip';
import { FrostPanel } from '@/components/ui/frost-panel';
import { StatusPill } from '@/components/ui/status-pill';

export function GenerateCreativesCta({
  brandReady,
  studioEnabled,
  brandProfileId,
}: {
  brandReady: boolean;
  /** Org passes the Creative Studio allowlist — page-computed (pin-safe). */
  studioEnabled: boolean;
  /**
   * The active brand profile — carried as a query param so the studio opens
   * scoped to THIS brand instead of re-deriving from the per-device persisted
   * selection (which can point at another brand in multi-brand orgs).
   */
  brandProfileId?: string;
}) {
  const t = useTranslations('BrandReport.generateCta');
  const studioHref = brandProfileId
    ? `/creative-studio?brandProfileId=${encodeURIComponent(brandProfileId)}`
    : '/creative-studio';
  return (
    <FrostPanel contentClassName="items-center gap-3 p-8 text-center">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Sparkles className="h-6 w-6 text-brand-text" />
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        {studioEnabled ? (
          <EyebrowChip>{t('brandGrounded')}</EyebrowChip>
        ) : (
          <EyebrowChip className="text-amber-600 dark:text-amber-400">
            {t('comingSoon')}
          </EyebrowChip>
        )}
      </div>
      <p className="max-w-xl text-sm text-muted-foreground">
        {t('description')}
      </p>
      <StatusPill tone={brandReady ? 'connected' : 'not_set'}>
        {brandReady ? t('brandReady') : t('addMoreData')}
      </StatusPill>
      {studioEnabled ? (
        <Button asChild className="btn-frost-primary gap-2">
          <Link href={studioHref}>
            <Sparkles className="h-4 w-4" />
            {t('title')}
          </Link>
        </Button>
      ) : (
        <Button disabled className="btn-frost-primary gap-2">
          <Sparkles className="h-4 w-4" />
          {t('title')}
        </Button>
      )}
    </FrostPanel>
  );
}

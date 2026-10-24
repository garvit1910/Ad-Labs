'use client';

import { Scale } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFormatLocale } from '@/hooks/useFormatLocale';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  DimensionOverIndex,
  MediaQuadrants,
  OverIndexDimension,
} from '@/lib/brand-identity/types';
import { DimensionView } from './MatrixDimensionView';
import { MediaBucketTabs } from './MediaBucketTabs';
import type { MatrixColorScheme } from './winners-matrix';
import { SectionHeader, useBrandIdentityNumbers } from './dashboard-shared';

// `angle` is the industry-specific angle vocabulary - the actionable lens.
// The universal/global angle (`angle_universal`) is still computed and stored
// (it feeds Layer-3 market distillation + library filters) but is NOT surfaced
// as its own tab here: two angle tabs read as confusing near-duplicates, and
// cross-industry angle comparison isn't the job of a single-org competitor view.
const DIMENSION_TABS: Array<{
  key: OverIndexDimension;
  labelKey: 'format' | 'hook' | 'offer' | 'angle';
}> = [
  { key: 'format', labelKey: 'format' },
  { key: 'hook_archetype', labelKey: 'hook' },
  { key: 'offer_type', labelKey: 'offer' },
  { key: 'angle', labelKey: 'angle' },
];

/**
 * "Winners vs the rest" - a per-facet performance matrix. Each tactic is a dot
 * placed in a four-quadrant scatter of over-index (x) × median win score (y),
 * with labels separated so nothing overlaps, flanked by a key takeaway and
 * ranking cards.
 * Tabs scope the layout to the LLM-label dimensions (Format / Hook / Offer /
 * Angle) plus the two per-media views (Images / Videos), which slice to that
 * media type and re-tab over its visual dimensions (style, aspect ratio, tone,
 * and - for video - pacing / duration).
 */
export function WinnersVsRestPanel({
  overIndex,
  labeledAds,
  totalAds,
  mediaQuadrants,
  colorScheme = 'category',
}: {
  overIndex: DimensionOverIndex[];
  labeledAds: number;
  totalAds: number;
  mediaQuadrants: MediaQuadrants;
  /** `signal` renders the monochrome-with-magenta treatment (Nimbus overview). */
  colorScheme?: MatrixColorScheme;
}) {
  const t = useTranslations('BrandIdentity.winnersVsRest');
  const tTabs = useTranslations('BrandIdentity.dimensionPanel.tabs');
  const numbers = useBrandIdentityNumbers();
  const formatLocale = useFormatLocale();
  const coverage = totalAds > 0 ? labeledAds / totalAds : 0;
  const byDimension = new Map(overIndex.map((d) => [d.dimension, d]));

  return (
    <section className="space-y-3">
      <SectionHeader
        icon={<Scale className="h-5 w-5" />}
        title={t('title')}
      />
      <Tabs defaultValue="format" className="w-full">
        <TabsList>
          {DIMENSION_TABS.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tTabs(tab.labelKey)}
            </TabsTrigger>
          ))}
          <TabsTrigger value="image">{tTabs('images')}</TabsTrigger>
          <TabsTrigger value="video">{tTabs('videos')}</TabsTrigger>
        </TabsList>
        {DIMENSION_TABS.map((tab) => {
          const dimension = byDimension.get(tab.key);
          return (
            <TabsContent key={tab.key} value={tab.key} className="mt-4">
              {dimension ? (
                <DimensionView dimension={dimension} colorScheme={colorScheme} />
              ) : (
                <p className="p-6 text-sm text-muted-foreground">{t('noData')}</p>
              )}
            </TabsContent>
          );
        })}
        {(['image', 'video'] as const).map((bucket) => (
          <TabsContent key={bucket} value={bucket} className="mt-4">
            <MediaBucketTabs
              group={mediaQuadrants[bucket]}
              bucket={bucket}
              renderDimension={(dimension) =>
                dimension ? (
                  <DimensionView dimension={dimension} colorScheme={colorScheme} />
                ) : (
                  <p className="p-6 text-sm text-muted-foreground">{t('noData')}</p>
                )
              }
            />
          </TabsContent>
        ))}
      </Tabs>
      {coverage < 0.8 && totalAds > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('coverage', {
            pct: numbers.pct(coverage),
            labeled: labeledAds.toLocaleString(formatLocale),
            total: totalAds.toLocaleString(formatLocale),
          })}
        </p>
      )}
    </section>
  );
}

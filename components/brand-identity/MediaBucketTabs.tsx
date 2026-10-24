'use client';

import type { ReactNode } from 'react';
import { ImageOff, VideoOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type {
  DimensionOverIndex,
  MediaQuadrantDimension,
  MediaQuadrantGroup,
} from '@/lib/brand-identity/types';
import { useFormatLocale } from '@/hooks/useFormatLocale';
import { useBrandIdentityNumbers } from './dashboard-shared';

export type MediaBucket = 'image' | 'video';

/** Visual dimensions per media bucket, ordered to match the type's dimension lists. */
/** `BrandIdentity.mediaBuckets.tabs` leaf rendered for a visual dimension tab. */
type MediaTabLabelKey = 'style' | 'aspectRatio' | 'tone' | 'setting' | 'pacing' | 'duration';

export const IMAGE_DIMENSION_TABS: Array<{
  key: MediaQuadrantDimension;
  label: string;
  labelKey: MediaTabLabelKey;
}> = [
  { key: 'style', label: 'Style', labelKey: 'style' },
  { key: 'aspect_ratio', label: 'Aspect ratio', labelKey: 'aspectRatio' },
  { key: 'tone', label: 'Tone', labelKey: 'tone' },
  { key: 'setting', label: 'Setting', labelKey: 'setting' },
];

export const VIDEO_DIMENSION_TABS: Array<{
  key: MediaQuadrantDimension;
  label: string;
  labelKey: MediaTabLabelKey;
}> = [
  { key: 'style', label: 'Style', labelKey: 'style' },
  { key: 'pacing', label: 'Pacing', labelKey: 'pacing' },
  { key: 'duration_bucket', label: 'Duration', labelKey: 'duration' },
  { key: 'tone', label: 'Tone', labelKey: 'tone' },
  { key: 'aspect_ratio', label: 'Aspect ratio', labelKey: 'aspectRatio' },
];

/** The dimension tab list for a bucket - images and videos carry different visuals. */
export function mediaDimensionTabs(bucket: MediaBucket) {
  return bucket === 'image' ? IMAGE_DIMENSION_TABS : VIDEO_DIMENSION_TABS;
}

/**
 * One media bucket's inner analysis: an empty state when the bucket has no ads,
 * otherwise a second row of dimension tabs plus a visual-label coverage note.
 * The image bucket carries a hint that carousels are included (they're labeled
 * from their poster frame).
 *
 * The bucket chrome is shared by both surfaces that slice by media type - the
 * "Winners vs the rest" quadrants and the "What's working by dimension" bars -
 * so only the per-dimension body differs, supplied by `renderDimension`
 * (undefined = that dimension is absent from the payload).
 */
export function MediaBucketTabs({
  group,
  bucket,
  renderDimension,
  contentClassName = 'mt-4',
}: {
  group: MediaQuadrantGroup;
  bucket: MediaBucket;
  renderDimension: (_dimension: DimensionOverIndex | undefined) => ReactNode;
  contentClassName?: string;
}) {
  const t = useTranslations('BrandIdentity.mediaBuckets');
  const numbers = useBrandIdentityNumbers();
  const formatLocale = useFormatLocale();
  if (group.totalAds === 0) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        {bucket === 'image' ? (
          <ImageOff className="h-5 w-5" />
        ) : (
          <VideoOff className="h-5 w-5" />
        )}
        {bucket === 'image' ? t('emptyImage') : t('emptyVideo')}
      </div>
    );
  }

  const tabs = mediaDimensionTabs(bucket);
  const byDimension = new Map(group.overIndex.map((d) => [d.dimension, d]));
  const coverage = group.visuallyLabeledAds / group.totalAds;

  return (
    <div className="space-y-3">
      {bucket === 'image' && (
        <p className="text-xs text-muted-foreground">
          {t('includesCarousels')}
        </p>
      )}
      <Tabs defaultValue={tabs[0].key} className="w-full">
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {t(`tabs.${tab.labelKey}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((tab) => (
          <TabsContent key={tab.key} value={tab.key} className={contentClassName}>
            {renderDimension(byDimension.get(tab.key))}
          </TabsContent>
        ))}
      </Tabs>
      {coverage < 0.8 && (
        <p className="text-xs text-muted-foreground">
          {t(bucket === 'image' ? 'coverageImage' : 'coverageVideo', {
            pct: numbers.pct(coverage),
            labeled: group.visuallyLabeledAds.toLocaleString(formatLocale),
            total: group.totalAds.toLocaleString(formatLocale),
          })}
        </p>
      )}
    </div>
  );
}

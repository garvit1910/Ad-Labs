'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { useOrganization } from '@/contexts/OrganizationContext';
import { brandIdentityRequest } from '@/lib/services/brand-identity';

/** Ads per request: the sheet asks for the 20-ad window holding the ad on screen. */
export const AD_SUMMARY_WINDOW = 20;

interface SummaryAd {
  id: string;
  summary: string | null;
}

interface LocalizedSummariesResponse {
  locale: string;
  summaries: Record<string, string>;
}

/** Ids (with a summary) of the fixed 20-ad window that contains `index`. */
export function adSummaryWindowIds(ads: readonly SummaryAd[], index: number): string[] {
  const start = Math.floor(Math.max(0, index) / AD_SUMMARY_WINDOW) * AD_SUMMARY_WINDOW;
  return ads
    .slice(start, start + AD_SUMMARY_WINDOW)
    .filter((ad) => typeof ad.summary === 'string' && ad.summary.trim() !== '')
    .map((ad) => ad.id);
}

/**
 * The AI label summary of `ads[index]` in the viewer's language (plan WS6, A8).
 * English viewers: no request, the stored English summary. Others: one request per
 * 20-ad window (`POST /api/brand-identity/labels/summaries`, cached), so paging
 * through the sheet does not refetch; until it answers — or when an ad has no
 * translation yet — the English summary shows. `translated` drives the
 * "AI-translated" marker.
 */
export function useLocalizedAdSummary(
  ads: readonly SummaryAd[],
  index: number,
): { summary: string | null; translated: boolean } {
  const locale = useLocale();
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;
  const current = ads[Math.min(Math.max(0, index), ads.length - 1)] ?? null;
  const ids = adSummaryWindowIds(ads, index);
  const english = current?.summary ?? null;
  const enabled = locale !== 'en' && !!organizationId && ids.length > 0 && !!english;

  const query = useQuery({
    queryKey: ['brand-identity', 'ad-summaries', organizationId, locale, ids.join(',')],
    queryFn: () =>
      brandIdentityRequest<LocalizedSummariesResponse>('labels/summaries', {
        organizationId,
        libraryAdIds: ids,
        ...(current ? { priorityId: current.id } : {}),
      }),
    enabled,
    staleTime: 1000 * 60 * 5,
    retry: false,
  });

  if (!enabled || !current || !query.data) return { summary: english, translated: false };
  const sameLanguage =
    query.data.locale.toLowerCase().split(/[-_]/)[0] === locale.toLowerCase().split(/[-_]/)[0];
  const translated = sameLanguage ? query.data.summaries?.[current.id] : undefined;
  return typeof translated === 'string' && translated.trim() !== ''
    ? { summary: translated, translated: true }
    : { summary: english, translated: false };
}

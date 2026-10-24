'use client';

import { useCallback } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import {
  competitiveLandscapeResponseSchema,
  type CompetitiveLandscapeResponse,
} from '@/lib/brand-presence/client-schemas';
import { applyLocalizedLandscape } from '@/lib/brand-presence/localized-themes';
import {
  BrandPresenceRequestError,
  brandPresenceRequest,
} from '@/lib/services/brand-presence';

const PATH = 'insights/competitive-landscape';

/** Statuses that mean "this org has no Brand Presence read here" — the
 * pre-release gate 404s non-allowlisted orgs, a foreign/removed profile 404s,
 * and a key without the scope 403s. The chapter hides; nothing is an error. */
const HIDDEN_STATUSES: ReadonlySet<number> = new Set([403, 404]);

export function competitiveLandscapeKey(
  organizationId?: string,
  brandProfileId?: string,
) {
  return [
    'brand-presence',
    'competitive-landscape',
    organizationId,
    brandProfileId,
  ] as const;
}

/** The landscape as rendered: `aiTranslated` when any theme label is an AI translation. */
export type LocalizedCompetitiveLandscape = CompetitiveLandscapeResponse & {
  aiTranslated?: boolean;
};

/**
 * The Brand Identity report's competitive-landscape read. Takes the ids as
 * params — the report resolves its brand through `useBrandIdentityScope()`,
 * which can differ from the Brand Presence page's selection, so this hook
 * never reads `useBrandProfileScope`. Resolves to `null` when Brand Presence
 * is not available for the org (403/404); callers hide the chapter on `null`
 * or `competitors.length === 0`. Other failures surface as query errors.
 *
 * i18n (WS8): the route attaches `localized` to a theme for a non-English viewer;
 * `select` swaps the label/summary in when its locale matches the CURRENT locale
 * (`applyLocalizedLandscape`) and flags the landscape `aiTranslated`. The locale is
 * part of the query key, so a language switch refetches. English: data untouched.
 */
export function useCompetitiveLandscape(params: {
  organizationId: string | undefined;
  brandProfileId: string | undefined;
}): UseQueryResult<LocalizedCompetitiveLandscape | null> {
  const { organizationId, brandProfileId } = params;
  const locale = useLocale();
  const localize = useCallback(
    (data: CompetitiveLandscapeResponse | null): LocalizedCompetitiveLandscape | null =>
      data ? applyLocalizedLandscape(data, locale) : data,
    [locale],
  );
  return useQuery({
    queryKey: [...competitiveLandscapeKey(organizationId, brandProfileId), locale],
    queryFn: async () => {
      try {
        return await brandPresenceRequest<CompetitiveLandscapeResponse>(
          PATH,
          { organizationId, brandProfileId },
          competitiveLandscapeResponseSchema,
        );
      } catch (error) {
        if (
          error instanceof BrandPresenceRequestError &&
          HIDDEN_STATUSES.has(error.status)
        ) {
          return null;
        }
        throw error;
      }
    },
    select: localize,
    enabled: !!organizationId && !!brandProfileId,
    staleTime: 60_000,
    retry: false,
  });
}

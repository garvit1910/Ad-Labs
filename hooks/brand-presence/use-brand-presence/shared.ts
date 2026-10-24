import { useCallback } from 'react';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BRAND_PRESENCE_ERROR_KEYS } from '@/lib/i18n/error-code-keys';
import { useLocalizeError, type CatalogKey } from '@/lib/i18n/localize-error';
import { sourcesKey, statusKey } from './query-keys';

/**
 * The standard Brand Presence mutation `onError`: toast the thrown message,
 * or `fallback` when the rejection is not an `Error`. English-only; React
 * hooks use `useMutationErrorToast()`.
 */
export function mutationErrorToast(fallback: string) {
  return (error: unknown) => {
    toast.error(error instanceof Error ? error.message : fallback);
  };
}

/**
 * Localized `mutationErrorToast`: English keeps the thrown message (or the
 * fallback copy); other locales translate the `BrandPresenceRequestError`
 * code/status, else show the operation's translated "…failed" copy.
 */
export type MutationErrorToastFn = <K extends string>(
  _fallbackKey: K & CatalogKey<K>,
) => (_error: unknown) => void;

export function useMutationErrorToast(): MutationErrorToastFn {
  const localize = useLocalizeError();
  // Implemented over plain strings: the generic signature checks each caller's key.
  return useCallback<MutationErrorToastFn>(
    (fallbackKey: string) => (error: unknown) => {
      toast.error(
        localize(error, { fallbackKey, codeKeys: BRAND_PRESENCE_ERROR_KEYS }),
      );
    },
    [localize],
  );
}

/**
 * Invalidates `extraKeys` (in order), then the brand's sources list, then its
 * status. Extras go FIRST because every setup/confirm hook refreshed its own
 * platform key before sources + status; keeping that order keeps the refetch
 * sequence identical. Only use this where a hook invalidates exactly
 * extras + sources + status — hooks with a different set stay explicit.
 */
export function invalidateSourceScope(
  queryClient: QueryClient,
  organizationId: string | undefined,
  brandProfileId: string | undefined,
  ...extraKeys: QueryKey[]
): void {
  for (const queryKey of extraKeys) {
    void queryClient.invalidateQueries({ queryKey });
  }
  void queryClient.invalidateQueries({
    queryKey: sourcesKey(organizationId, brandProfileId),
  });
  void queryClient.invalidateQueries({
    queryKey: statusKey(organizationId, brandProfileId),
  });
}

/** The shape every resolve-then-scrape platform read (Google Maps,
 * Trustpilot, TikTok, Instagram) exposes for its activity poll. */
export interface SourceBusyState {
  resolving: boolean;
  scraping: boolean;
  sourceStatus: string | null;
}

/**
 * `refetchInterval` for a resolve-then-scrape platform read: poll every 5s
 * while the resolve probe or review/comment scrape is in flight (or the
 * source job is pending/running), otherwise stop.
 */
export function pollWhileSourceBusy<TData extends SourceBusyState>(query: {
  state: { data: TData | undefined };
}): number | false {
  const data = query.state.data;
  const busy =
    data?.resolving === true ||
    data?.scraping === true ||
    data?.sourceStatus === 'pending' ||
    data?.sourceStatus === 'running';
  return busy ? 5000 : false;
}

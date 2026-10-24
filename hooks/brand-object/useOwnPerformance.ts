'use client';

/**
 * The "What's working for you" read — the org's own ad performance per
 * creative label (`POST /api/brand-object/own-performance`).
 *
 * Keyed like `useOwnAdAngles`: ORG-scoped (`own_ad_labels` has no brand, so a
 * profile in the key would only fragment the cache into identical copies) and
 * deliberately NOT swept by a Brand Object build's invalidation — own ads are
 * labeled by the nightly cron, and a distillation run cannot change them. The
 * route still requires the selected brand profile (its org-membership check),
 * so the query waits for one.
 *
 * A 403/404 (org off the pre-release allowlist, or a stale profile) resolves to
 * `EMPTY_OWN_PERFORMANCE` — the chapter hides; nothing is an error state.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getAuthHeaders } from '@/hooks/use-organization-queries/auth-headers';
import { useBrandIdentityScope } from '@/hooks/brand-object/useBrandIdentityScope';
import { useBrandReportEnabled } from '@/hooks/brand-object/useBrandReportEnabled';
import {
  DEFAULT_OWN_PERFORMANCE_WINDOW,
  EMPTY_OWN_PERFORMANCE,
  type OwnPerformanceModel,
  type OwnPerformanceWindow,
} from '@/lib/brand-object/own-performance';
import { CodedError, errorCodeFromBody } from '@/lib/i18n/localize-error';

const HIDDEN_STATUSES: ReadonlySet<number> = new Set([403, 404]);

export function ownPerformanceKey(
  organizationId: string | undefined,
  windowDays: OwnPerformanceWindow,
) {
  return ['brand-object', 'own-performance', organizationId, windowDays] as const;
}

async function fetchOwnPerformance(body: {
  organizationId: string;
  brandProfileId: string;
  windowDays: OwnPerformanceWindow;
}): Promise<OwnPerformanceModel> {
  const headers = await getAuthHeaders();
  const response = await fetch('/api/brand-object/own-performance', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (HIDDEN_STATUSES.has(response.status)) {
    return { ...EMPTY_OWN_PERFORMANCE, windowDays: body.windowDays };
  }
  const payload = (await response.json().catch(() => null)) as {
    data?: { model?: OwnPerformanceModel };
    reason?: string;
  } | null;
  if (!response.ok) {
    // CodedError keeps the English message and adds `code`/`status` so the
    // render site can localize it (`useLocalizeError`).
    throw new CodedError(payload?.reason ?? `Request failed (${response.status})`, {
      code: errorCodeFromBody(payload),
      status: response.status,
    });
  }
  return payload?.data?.model ?? { ...EMPTY_OWN_PERFORMANCE, windowDays: body.windowDays };
}

export function useOwnPerformance(
  windowDays: OwnPerformanceWindow = DEFAULT_OWN_PERFORMANCE_WINDOW,
): UseQueryResult<OwnPerformanceModel> {
  const { organizationId, selectedProfileId } = useBrandIdentityScope();
  // Org-scoped read: gate on the report allowlist directly (the route 404s
  // everyone else), exactly like `useOwnAdAngles`.
  const reportEnabled = useBrandReportEnabled();
  return useQuery({
    queryKey: ownPerformanceKey(organizationId, windowDays),
    enabled: Boolean(organizationId && selectedProfileId) && reportEnabled,
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      fetchOwnPerformance({
        organizationId: organizationId as string,
        brandProfileId: selectedProfileId as string,
        windowDays,
      }),
  });
}

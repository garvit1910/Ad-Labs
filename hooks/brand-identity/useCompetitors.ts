'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useLocalizeError } from '@/lib/i18n/localize-error';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useBrandProfileScope } from '@/hooks/brand-presence/useBrandProfileScope';
import { getAuthHeaders } from '@/hooks/use-organization-queries/auth-headers';
import type { TrackedCompetitor } from '@/lib/brand-identity/types';
import { isCompetitorLabeling } from '@/lib/brand-identity/labeling';
import { brandIdentityRequest } from '@/lib/services/brand-identity';
import { usePlanLimitPrompt } from '@/components/billing/PlanLimitDialog';
import { orgBillingKeys } from '@/hooks/billing/use-org-billing';

type JobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

const TERMINAL_JOB_STATUSES: JobStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

/** Input accepted by the create-competitor mutation (and create-and-sync). */
export interface CreateCompetitorInput {
  keyword?: string;
  pageRef?: string;
  metaPageId?: string;
  googleAdvertiserUrl?: string;
  country?: string;
  name?: string;
  /**
   * Which brand this competitor informs. Omitted → defaults to the active
   * brand profile from scope; explicit `null` forces an org-shared row.
   */
  brandProfileId?: string | null;
  /**
   * When true this is the brand's OWN Facebook page (first-party), not a
   * competitor — scraped the same way but routed to identity and hidden from
   * competitor lists. Requires a resolved brandProfileId + a Meta page.
   */
  isSelf?: boolean;
}

/**
 * Polls the auth'd `GET /api/jobs/[jobId]` route for a single job and derives
 * terminality from the status so we don't depend on the response envelope shape.
 */
async function fetchJobStatus(
  jobId: string
): Promise<{ status: JobStatus; isTerminal: boolean }> {
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/jobs/${jobId}`, { headers });
  // A non-OK poll (e.g. 404/401) must resolve as terminal so the indicator can
  // never spin forever; the background job keeps running regardless.
  if (!response.ok) {
    return { status: 'failed', isTerminal: true };
  }
  const payload = (await response.json().catch(() => null)) as {
    data?: { status?: JobStatus };
  } | null;
  const status = (payload?.data?.status ?? 'pending') as JobStatus;
  return { status, isTerminal: TERMINAL_JOB_STATUSES.includes(status) };
}

export function useCompetitors() {
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useQuery({
    queryKey: ['brand-identity', 'competitors', organizationId],
    queryFn: () =>
      brandIdentityRequest<TrackedCompetitor[]>('competitors/list', {
        organizationId,
      }),
    enabled: !!organizationId,
    staleTime: 1000 * 30,
    // Poll while any competitor is still syncing or labelling so the "Syncing…"
    // button state, the green labelling indicator, and the "N labeled" counts all
    // climb live; stops once everything is caught up.
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (competitor) =>
          competitor.syncing || isCompetitorLabeling(competitor)
      )
        ? 3000
        : false,
  });
}

/** The org-scoped surfaces a competitor mutation actually changes. */
const COMPETITOR_DATA_SCOPES = [
  'competitors',
  'competitor-detail',
  'library',
  'overview',
  'dashboard',
] as const;

/**
 * Scoped invalidation for competitor mutations — refreshes the org's
 * competitor-derived caches but never the global industry catalog or the
 * collections caches. (Invalidating the whole `['brand-identity']` tree here
 * re-fetched those too — the exact lag pattern useCollections already
 * diagnosed and scoped away for saves.)
 */
function useInvalidateBrandIdentity() {
  const queryClient = useQueryClient();
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;
  return useCallback(() => {
    for (const scope of COMPETITOR_DATA_SCOPES) {
      void queryClient.invalidateQueries({
        queryKey: ['brand-identity', scope, organizationId],
      });
    }
  }, [queryClient, organizationId]);
}

export function useCreateCompetitor() {
  const t = useTranslations('BrandIdentity.toasts');
  const localizeError = useLocalizeError();
  const { currentOrganization } = useOrganization();
  const scope = useBrandProfileScope();
  const invalidate = useInvalidateBrandIdentity();
  const queryClient = useQueryClient();
  // Plan limit (402): the shell's plan-limit dialog replaces the error toast.
  const { handleBillingError } = usePlanLimitPrompt({ feature: 'competitors' });
  const activeBrandProfileId = scope.selectedProfileId;

  return useMutation({
    mutationFn: (input: CreateCompetitorInput) => {
      // Default-tag to the active brand (agency scoping); an explicit null
      // opts out. The route schema takes a uuid or nothing — never null.
      const { brandProfileId, ...rest } = input;
      const resolved =
        brandProfileId === undefined ? activeBrandProfileId : brandProfileId;
      return brandIdentityRequest('competitors/create', {
        organizationId: currentOrganization?.id,
        ...rest,
        ...(resolved ? { brandProfileId: resolved } : {}),
      });
    },
    onSuccess: () => {
      // The sync toast ("Sync started…") follows immediately via
      // useCreateAndSyncCompetitor, so keep this one neutral and non-imperative.
      toast.success(t('competitorAdded'));
      void invalidate();
      // The competitor count behind the plan-usage hint moved.
      if (currentOrganization?.id) {
        void queryClient.invalidateQueries({ queryKey: orgBillingKeys.org(currentOrganization.id) });
      }
    },
    onError: (error) => {
      if (handleBillingError(error)) return;
      toast.error(localizeError(error, { fallbackKey: 'BrandIdentity.toasts.competitorAddFailed' }));
    },
  });
}

export function useUpdateCompetitor() {
  const localizeError = useLocalizeError();
  const { currentOrganization } = useOrganization();
  const invalidate = useInvalidateBrandIdentity();

  return useMutation({
    mutationFn: (input: {
      competitorId: string;
      name?: string;
      status?: 'active' | 'paused';
      industry?: string | null;
      brandProfileId?: string | null;
    }) =>
      brandIdentityRequest('competitors/update', {
        organizationId: currentOrganization?.id,
        ...input,
      }),
    onSuccess: () => {
      void invalidate();
    },
    onError: (error) => {
      toast.error(localizeError(error, { fallbackKey: 'BrandIdentity.toasts.competitorUpdateFailed' }));
    },
  });
}

export function useDeleteCompetitor() {
  const t = useTranslations('BrandIdentity.toasts');
  const localizeError = useLocalizeError();
  const { currentOrganization } = useOrganization();
  const invalidate = useInvalidateBrandIdentity();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (competitorId: string) =>
      brandIdentityRequest('competitors/delete', {
        organizationId: currentOrganization?.id,
        competitorId,
      }),
    onSuccess: () => {
      toast.success(t('competitorRemoved'));
      void invalidate();
      if (currentOrganization?.id) {
        void queryClient.invalidateQueries({ queryKey: orgBillingKeys.org(currentOrganization.id) });
      }
    },
    onError: (error) => {
      toast.error(localizeError(error, { fallbackKey: 'BrandIdentity.toasts.competitorDeleteFailed' }));
    },
  });
}

export function useSyncCompetitor() {
  const t = useTranslations('BrandIdentity.toasts');
  const localizeError = useLocalizeError();
  const { currentOrganization } = useOrganization();
  const invalidate = useInvalidateBrandIdentity();

  return useMutation({
    mutationFn: (competitorId: string) =>
      brandIdentityRequest<{ queued: boolean; jobId: string; deduped: boolean }>(
        'competitors/sync',
        {
          organizationId: currentOrganization?.id,
          competitorId,
        }
      ),
    onSuccess: (result) => {
      toast.success(result.deduped ? t('syncInProgress') : t('syncStarted'));
      void invalidate();
    },
    onError: (error) => {
      toast.error(localizeError(error, { fallbackKey: 'BrandIdentity.toasts.syncQueueFailed' }));
    },
  });
}

/**
 * Wraps {@link useSyncCompetitor} and keeps a live "syncing" state for the full
 * duration of the background ad-library job: it captures the queued `jobId`, polls
 * `GET /api/jobs/[jobId]` until the job is terminal, then refreshes competitor data.
 * `isSyncing` stays continuously true from click through job completion so callers
 * can render a persistent loading indicator (no gap between the 202 and the first poll).
 */
export function useCompetitorSync() {
  const t = useTranslations('BrandIdentity.toasts');
  const syncMutation = useSyncCompetitor();
  const invalidate = useInvalidateBrandIdentity();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const job = useQuery({
    queryKey: ['brand-identity', 'job', activeJobId],
    queryFn: () => fetchJobStatus(activeJobId as string),
    enabled: !!activeJobId,
    refetchInterval: (query) =>
      query.state.data?.isTerminal ? false : 3000,
  });

  const jobStatus = job.data?.status;
  const isTerminal = job.data?.isTerminal ?? false;

  useEffect(() => {
    if (!activeJobId || !isTerminal) return;
    setActiveJobId(null);
    void invalidate();
    if (jobStatus === 'completed') {
      toast.success(t('syncComplete'));
    } else if (jobStatus === 'failed') {
      toast.error(t('syncFailed'));
    } else if (jobStatus === 'cancelled') {
      toast.error(t('syncCancelled'));
    }
  }, [activeJobId, isTerminal, jobStatus, invalidate, t]);

  const triggerSync = useCallback(
    (competitorId: string) => {
      syncMutation.mutate(competitorId, {
        onSuccess: (result) => {
          if (result?.jobId) setActiveJobId(result.jobId);
        },
      });
    },
    [syncMutation]
  );

  const isSyncing =
    syncMutation.isPending || (!!activeJobId && !isTerminal);

  return { triggerSync, isSyncing };
}

/**
 * Create a competitor and immediately kick off its ad-library sync with the new
 * id. Creating only inserts the row — without this follow-up sync the competitor
 * has zero ads until someone clicks "Sync now". Every add-competitor form (the
 * website resolver and the keyword/page/Google forms) must go through this so the
 * "adding a competitor pulls their ads" contract can never drift per-form again.
 */
export function useCreateAndSyncCompetitor() {
  const createCompetitor = useCreateCompetitor();
  const { triggerSync } = useCompetitorSync();

  const createAndSync = useCallback(
    (input: CreateCompetitorInput, onDone?: () => void) => {
      createCompetitor.mutate(input, {
        onSuccess: (created) => {
          const id = (created as { id?: string } | undefined)?.id;
          if (id) triggerSync(id);
          onDone?.();
        },
      });
    },
    [createCompetitor, triggerSync]
  );

  return { createAndSync, isPending: createCompetitor.isPending };
}

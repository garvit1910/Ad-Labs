'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { isPipelineActiveSource } from '@/lib/brand-presence/awaiting-confirm';
import type {
  BrandPresenceSource,
  SubredditClassification,
} from '@/lib/brand-presence/types';
import {
  brandPresenceStatusSchema,
  type BrandPresenceStatus as ValidatedBrandPresenceStatus,
} from '@/lib/brand-presence/client-schemas';
import { brandPresenceRequest } from '@/lib/services/brand-presence';
import { brandProfilesKey } from '../useBrandProfiles';
import { useBrandProfileScope } from '../useBrandProfileScope';
import {
  activityStatusKey,
  amazonProductsKey,
  googleInsightsKey,
  googlePlaceKey,
  highlightsPrefixKey,
  insightsKey,
  mentionsPrefixKey,
  roomsPrefixKey,
  sourcesKey,
  statsStatusKey,
  statusKey,
  themesPrefixKey,
  threadsPrefixKey,
  trustpilotKey,
} from './query-keys';
import { invalidateSourceScope, useMutationErrorToast } from './shared';

export type BrandPresenceStatus = ValidatedBrandPresenceStatus;

/** Sources + registry-merged cards; polls while the pipeline is active. */
export function useBrandPresenceSources() {
  const { organizationId, selectedProfileId } = useBrandProfileScope();

  const sources = useQuery({
    queryKey: sourcesKey(organizationId, selectedProfileId),
    queryFn: () =>
      brandPresenceRequest<{
        sources: BrandPresenceSource[];
        mentionCounts: Record<string, number>;
      }>('sources/list', {
        organizationId,
        brandProfileId: selectedProfileId,
      }),
    enabled: !!organizationId && !!selectedProfileId,
    staleTime: 1000 * 15,
  });

  const activityStatus = useQuery({
    queryKey: activityStatusKey(organizationId, selectedProfileId),
    queryFn: () =>
      brandPresenceRequest<BrandPresenceStatus>('status', {
        organizationId,
        brandProfileId: selectedProfileId,
        include: 'activity',
      }, brandPresenceStatusSchema),
    enabled: !!organizationId && !!selectedProfileId,
    refetchInterval: (query) => {
      const data = query.state.data;
      // Awaiting-confirm sources are parked on the founder — they must not
      // keep the 5s poll (or the "Listening…" indicator below) alive forever.
      const active =
        (data?.activeJobs.length ?? 0) > 0 ||
        (data?.sources ?? []).some(isPipelineActiveSource);
      return active ? 5000 : false;
    },
  });

  const statsStatus = useQuery({
    queryKey: statsStatusKey(organizationId, selectedProfileId),
    queryFn: () =>
      brandPresenceRequest<BrandPresenceStatus>(
        'status',
        {
          organizationId,
          brandProfileId: selectedProfileId,
          include: 'full',
        },
        brandPresenceStatusSchema,
      ),
    enabled: !!organizationId && !!selectedProfileId,
    staleTime: 1000 * 30,
  });

  const status = {
    ...activityStatus,
    data: activityStatus.data
      ? { ...activityStatus.data, counts: statsStatus.data?.counts ?? null }
      : statsStatus.data,
    isLoading: activityStatus.isLoading || statsStatus.isLoading,
    isError: activityStatus.isError || statsStatus.isError,
    error: activityStatus.error ?? statsStatus.error,
  };

  const queryClient = useQueryClient();
  const pipelineActive =
    (activityStatus.data?.activeJobs.length ?? 0) > 0 ||
    (activityStatus.data?.sources ?? []).some(isPipelineActiveSource);

  // Refresh the heavier sources/mentions reads whenever the pipeline settles.
  const [wasActive, setWasActive] = useState(false);
  useEffect(() => {
    if (pipelineActive) {
      setWasActive(true);
      return;
    }
    if (!wasActive) return;
    setWasActive(false);
    void queryClient.invalidateQueries({
      queryKey: sourcesKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: statsStatusKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: mentionsPrefixKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: threadsPrefixKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: roomsPrefixKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: insightsKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: amazonProductsKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: googlePlaceKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: googleInsightsKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: trustpilotKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: themesPrefixKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: highlightsPrefixKey(organizationId, selectedProfileId),
    });
    void queryClient.invalidateQueries({
      queryKey: brandProfilesKey(organizationId),
    });
  }, [pipelineActive, wasActive, organizationId, selectedProfileId, queryClient]);

  return { sources, status, pipelineActive };
}

export function useAddSubreddit() {
  const { organizationId, selectedProfileId } = useBrandProfileScope();
  const queryClient = useQueryClient();
  const t = useTranslations('BrandPresence.toasts');
  const errorToast = useMutationErrorToast();
  return useMutation({
    mutationFn: (input: {
      subreddit: string;
      classification?: SubredditClassification;
    }) =>
      brandPresenceRequest<{ sourceId: string; subreddit: string }>(
        'sources/subreddit/add',
        { organizationId, brandProfileId: selectedProfileId, ...input },
      ),
    onSuccess: (result) => {
      toast.success(t('subredditAdded', { subreddit: result.subreddit }));
      invalidateSourceScope(queryClient, organizationId, selectedProfileId);
    },
    onError: errorToast('BrandPresence.toasts.addSubredditFailed'),
  });
}

export function useRemoveSubreddit() {
  const { organizationId, selectedProfileId } = useBrandProfileScope();
  const queryClient = useQueryClient();
  const t = useTranslations('BrandPresence.toasts');
  const errorToast = useMutationErrorToast();
  return useMutation({
    // The remove route is source-id scoped (no brandProfileId needed).
    mutationFn: (sourceId: string) =>
      brandPresenceRequest<{ removed: boolean }>('sources/subreddit/remove', {
        organizationId,
        sourceId,
      }),
    onSuccess: () => {
      toast.success(t('subredditRemoved'));
      invalidateSourceScope(queryClient, organizationId, selectedProfileId);
    },
    onError: errorToast('BrandPresence.toasts.removeSubredditFailed'),
  });
}

export function useSyncSource() {
  const { organizationId, selectedProfileId } = useBrandProfileScope();
  const queryClient = useQueryClient();
  const t = useTranslations('BrandPresence.toasts');
  const errorToast = useMutationErrorToast();
  return useMutation({
    // The sync route reads brandProfileId off the source row (source-id scoped).
    mutationFn: (sourceId: string) =>
      brandPresenceRequest<{ queued: boolean; jobId: string }>('sources/sync', {
        organizationId,
        sourceId,
      }),
    onSuccess: () => {
      toast.success(t('resyncQueued'));
      // Status only: this hook never invalidated the sources list.
      void queryClient.invalidateQueries({
        queryKey: statusKey(organizationId, selectedProfileId),
      });
    },
    onError: errorToast('BrandPresence.toasts.resyncFailed'),
  });
}

'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useLocalizeError } from '@/lib/i18n/localize-error';
import { useOrganization } from '@/contexts/OrganizationContext';
import { brandIdentityRequest } from '@/lib/services/brand-identity';
import type {
  EnrichedAd,
  SavedCollectionDetail,
  SavedCollectionSummary,
} from '@/lib/brand-identity/types';

/** Map of "platform:external_ad_id" → collection ids that contain that ad. */
type MembershipMap = Record<string, string[]>;

const collectionsKey = (orgId?: string) =>
  ['brand-identity', 'collections', orgId] as const;
const membershipKey = (orgId?: string) =>
  ['brand-identity', 'collections-membership', orgId] as const;
const collectionDetailKey = (orgId?: string, collectionId?: string | null) =>
  ['brand-identity', 'collection', orgId, collectionId] as const;

const adKeyOf = (ad: Pick<EnrichedAd, 'platform' | 'external_ad_id'>) =>
  `${ad.platform}:${ad.external_ad_id}`;

/**
 * Scoped invalidation — touches ONLY the collection caches, never the heavy
 * competitors/dashboard/library queries (invalidating the whole
 * `['brand-identity']` tree on a save caused the lag the user reported).
 */
function invalidateCollections(
  qc: QueryClient,
  orgId?: string,
  collectionId?: string
) {
  void qc.invalidateQueries({ queryKey: collectionsKey(orgId) });
  void qc.invalidateQueries({ queryKey: membershipKey(orgId) });
  if (collectionId) {
    void qc.invalidateQueries({
      queryKey: collectionDetailKey(orgId, collectionId),
    });
  }
}

export function useCollections() {
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useQuery({
    queryKey: collectionsKey(organizationId),
    queryFn: () =>
      brandIdentityRequest<SavedCollectionSummary[]>('collections/list', {
        organizationId,
      }),
    enabled: !!organizationId,
    staleTime: 1000 * 30,
  });
}

export function useCollectionDetail(collectionId: string | null) {
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useQuery({
    queryKey: collectionDetailKey(organizationId, collectionId),
    queryFn: () =>
      brandIdentityRequest<SavedCollectionDetail>('collections/detail', {
        organizationId,
        collectionId,
      }),
    enabled: !!organizationId && !!collectionId,
    staleTime: 1000 * 30,
  });
}

/**
 * Single org-wide membership map. Drives both the bookmark filled state and the
 * popover checkboxes, fetched once per org so the popover opens instantly and
 * optimistic toggles update it in place.
 */
export function useCollectionsMembership() {
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useQuery({
    queryKey: membershipKey(organizationId),
    queryFn: () =>
      brandIdentityRequest<MembershipMap>('collections/membership', {
        organizationId,
      }),
    enabled: !!organizationId,
    staleTime: 1000 * 30,
  });
}

export function useCreateCollection() {
  const t = useTranslations('BrandIdentity.toasts');
  const localizeError = useLocalizeError();
  const qc = useQueryClient();
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      brandIdentityRequest<SavedCollectionSummary>('collections/create', {
        organizationId,
        ...input,
      }),
    onSuccess: () => {
      toast.success(t('collectionCreated'));
      invalidateCollections(qc, organizationId);
    },
    onError: (error) => {
      toast.error(
        localizeError(error, { fallbackKey: 'BrandIdentity.toasts.collectionCreateFailed' })
      );
    },
  });
}

export function useUpdateCollection() {
  const t = useTranslations('BrandIdentity.toasts');
  const localizeError = useLocalizeError();
  const qc = useQueryClient();
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useMutation({
    mutationFn: (input: {
      collectionId: string;
      name?: string;
      description?: string | null;
    }) =>
      brandIdentityRequest('collections/update', {
        organizationId,
        ...input,
      }),
    onSuccess: (_data, vars) => {
      toast.success(t('collectionUpdated'));
      invalidateCollections(qc, organizationId, vars.collectionId);
    },
    onError: (error) => {
      toast.error(
        localizeError(error, { fallbackKey: 'BrandIdentity.toasts.collectionUpdateFailed' })
      );
    },
  });
}

export function useDeleteCollection() {
  const t = useTranslations('BrandIdentity.toasts');
  const localizeError = useLocalizeError();
  const qc = useQueryClient();
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useMutation({
    mutationFn: (collectionId: string) =>
      brandIdentityRequest('collections/delete', {
        organizationId,
        collectionId,
      }),
    onSuccess: (_data, collectionId) => {
      toast.success(t('collectionDeleted'));
      // Membership changes too (its ads may leave the org's saved set).
      invalidateCollections(qc, organizationId, collectionId);
    },
    onError: (error) => {
      toast.error(
        localizeError(error, { fallbackKey: 'BrandIdentity.toasts.collectionDeleteFailed' })
      );
    },
  });
}

export function useSaveAdToCollection() {
  const localizeError = useLocalizeError();
  const qc = useQueryClient();
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useMutation({
    mutationFn: (input: {
      collectionId: string;
      ad: EnrichedAd;
      notes?: string;
    }) =>
      brandIdentityRequest<{ savedAd: unknown; alreadySaved: boolean }>(
        'collections/add-ad',
        {
          organizationId,
          collectionId: input.collectionId,
          libraryAdId: input.ad.id,
          notes: input.notes,
        }
      ),
    onMutate: async ({ collectionId, ad }) => {
      const mKey = membershipKey(organizationId);
      const cKey = collectionsKey(organizationId);
      await qc.cancelQueries({ queryKey: mKey });
      await qc.cancelQueries({ queryKey: cKey });
      const prevMembership = qc.getQueryData<MembershipMap>(mKey);
      const prevCollections = qc.getQueryData<SavedCollectionSummary[]>(cKey);
      const key = adKeyOf(ad);

      qc.setQueryData<MembershipMap>(mKey, (old) => {
        const map = { ...(old ?? {}) };
        map[key] = Array.from(new Set([...(map[key] ?? []), collectionId]));
        return map;
      });
      qc.setQueryData<SavedCollectionSummary[]>(cKey, (old) =>
        (old ?? []).map((c) =>
          c.id === collectionId ? { ...c, adCount: c.adCount + 1 } : c
        )
      );

      return { prevMembership, prevCollections };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.prevMembership !== undefined) {
        qc.setQueryData(membershipKey(organizationId), ctx.prevMembership);
      }
      if (ctx?.prevCollections !== undefined) {
        qc.setQueryData(collectionsKey(organizationId), ctx.prevCollections);
      }
      toast.error(localizeError(error, { fallbackKey: 'BrandIdentity.toasts.saveAdFailed' }));
    },
    onSettled: (_data, _err, vars) => {
      invalidateCollections(qc, organizationId, vars.collectionId);
    },
  });
}

export function useRemoveAdFromCollection() {
  const localizeError = useLocalizeError();
  const qc = useQueryClient();
  const { currentOrganization } = useOrganization();
  const organizationId = currentOrganization?.id;

  return useMutation({
    mutationFn: (input: { collectionId: string; ad: EnrichedAd }) =>
      brandIdentityRequest('collections/remove-ad', {
        organizationId,
        collectionId: input.collectionId,
        externalAdId: input.ad.external_ad_id,
        platform: input.ad.platform,
      }),
    onMutate: async ({ collectionId, ad }) => {
      const mKey = membershipKey(organizationId);
      const cKey = collectionsKey(organizationId);
      const dKey = collectionDetailKey(organizationId, collectionId);
      await qc.cancelQueries({ queryKey: mKey });
      await qc.cancelQueries({ queryKey: cKey });
      await qc.cancelQueries({ queryKey: dKey });
      const prevMembership = qc.getQueryData<MembershipMap>(mKey);
      const prevCollections = qc.getQueryData<SavedCollectionSummary[]>(cKey);
      const prevDetail = qc.getQueryData<SavedCollectionDetail>(dKey);
      const key = adKeyOf(ad);

      qc.setQueryData<MembershipMap>(mKey, (old) => {
        if (!old) return old;
        const map = { ...old };
        const next = (map[key] ?? []).filter((id) => id !== collectionId);
        if (next.length) map[key] = next;
        else delete map[key];
        return map;
      });
      qc.setQueryData<SavedCollectionSummary[]>(cKey, (old) =>
        (old ?? []).map((c) =>
          c.id === collectionId
            ? { ...c, adCount: Math.max(0, c.adCount - 1) }
            : c
        )
      );
      // If the collection's detail is open, drop the ad from it immediately.
      qc.setQueryData<SavedCollectionDetail>(dKey, (old) =>
        old
          ? {
              ...old,
              ads: old.ads.filter(
                (i) =>
                  !(
                    i.platform === ad.platform &&
                    i.external_ad_id === ad.external_ad_id
                  )
              ),
            }
          : old
      );

      return { prevMembership, prevCollections, prevDetail };
    },
    onError: (error, vars, ctx) => {
      if (ctx?.prevMembership !== undefined) {
        qc.setQueryData(membershipKey(organizationId), ctx.prevMembership);
      }
      if (ctx?.prevCollections !== undefined) {
        qc.setQueryData(collectionsKey(organizationId), ctx.prevCollections);
      }
      if (ctx?.prevDetail !== undefined) {
        qc.setQueryData(
          collectionDetailKey(organizationId, vars.collectionId),
          ctx.prevDetail
        );
      }
      toast.error(localizeError(error, { fallbackKey: 'BrandIdentity.toasts.removeAdFailed' }));
    },
    onSettled: (_data, _err, vars) => {
      invalidateCollections(qc, organizationId, vars.collectionId);
    },
  });
}

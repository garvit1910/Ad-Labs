'use client';

import { useState } from 'react';
import { Check, Loader2, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { EnrichedAd } from '@/lib/brand-identity/types';
import {
  useCollections,
  useCollectionsMembership,
  useCreateCollection,
  useRemoveAdFromCollection,
  useSaveAdToCollection,
} from '@/hooks/brand-identity/useCollections';

/**
 * Popover body for toggling an ad into/out of collections. Reads the shared,
 * already-warm `useCollections` + `useCollectionsMembership` queries (no
 * per-open fetch), and the checkbox flips instantly via optimistic updates -
 * no waiting on the server. Stays open so a user can toggle several collections.
 */
export function SaveToCollectionPopover({ ad }: { ad: EnrichedAd }) {
  const { data: collections, isLoading } = useCollections();
  const { data: membership } = useCollectionsMembership();
  const save = useSaveAdToCollection();
  const remove = useRemoveAdFromCollection();
  const create = useCreateCollection();
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const t = useTranslations('BrandIdentity.saveAd');

  const inCollections = new Set(membership?.[`${ad.platform}:${ad.external_ad_id}`] ?? []);

  const toggle = (collectionId: string) => {
    if (inCollections.has(collectionId)) {
      remove.mutate({ collectionId, ad });
    } else {
      save.mutate({ collectionId, ad });
    }
  };

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate(
      { name },
      {
        onSuccess: (collection) => {
          setNewName('');
          setCreating(false);
          if (collection?.id) save.mutate({ collectionId: collection.id, ad });
        },
      }
    );
  };

  const list = collections ?? [];

  return (
    <div className="flex flex-col">
      <div className="border-b px-3 py-2 text-sm font-semibold">
        {t('popoverTitle')}
      </div>

      <div className="max-h-64 overflow-y-auto p-1">
        {isLoading && list.length === 0 ? (
          <div className="space-y-1 p-1">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        ) : list.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            {t('popoverEmpty')}
          </p>
        ) : (
          list.map((c) => {
            const checked = inCollections.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={checked}
                onClick={() => toggle(c.id)}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent"
              >
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                    checked
                      ? 'border-brand-primary bg-brand-primary text-white'
                      : 'border-muted-foreground/40'
                  )}
                >
                  {checked && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="flex-1 truncate">{c.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {c.adCount}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="border-t p-2">
        {creating ? (
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') setCreating(false);
              }}
              placeholder={t('namePlaceholder')}
              className="h-8"
            />
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={create.isPending || !newName.trim()}
            >
              {create.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t('add')
              )}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => setCreating(true)}
          >
            <Plus className="h-4 w-4" /> {t('newCollection')}
          </Button>
        )}
      </div>
    </div>
  );
}

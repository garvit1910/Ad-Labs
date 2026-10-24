'use client';

import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TrackedCompetitor } from '@/lib/brand-identity/types';

const ALL = 'all';
// Sentinel for the "Add competitor" row - intercepted in onValueChange so it
// navigates to the Competitors tab instead of ever becoming the selection.
const ADD = '__add_competitor__';
// The Competitors tab owns the add flow (it renders `AddCompetitorButtons` at
// the top), so the dropdown row routes there rather than duplicating a modal.
const COMPETITORS_TAB_HREF = '/brand-identity/competitors';

export function DashboardCompetitorSelector({
  competitors,
  value,
  onChange,
}: {
  competitors: TrackedCompetitor[];
  /** undefined = all-competitors aggregate. */
  value: string | undefined;
  onChange: (_id: string | undefined) => void;
}) {
  const router = useRouter();
  const t = useTranslations('BrandIdentity.scopeFilters');

  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next) => {
        if (next === ADD) {
          router.push(COMPETITORS_TAB_HREF);
          return;
        }
        onChange(next === ALL ? undefined : next);
      }}
    >
      <SelectTrigger className="w-full sm:w-auto sm:max-w-[240px]">
        <SelectValue placeholder={t('allCompetitors')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t('allCompetitors')}</SelectItem>
        {competitors.map((competitor) => (
          <SelectItem key={competitor.id} value={competitor.id}>
            {competitor.name}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={ADD}>
          <span className="flex items-center gap-2 text-brand-text">
            <Plus className="h-4 w-4" />
            {t('addCompetitor')}
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

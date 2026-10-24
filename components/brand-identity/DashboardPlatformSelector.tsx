'use client';

import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { DashboardPlatform } from '@/hooks/brand-identity/useBrandIdentityDashboard';

/** Platform names are not translated; only the "all" option is catalog copy. */
const PLATFORM_LABELS: Record<Exclude<DashboardPlatform, 'all'>, string> = {
  meta: 'Meta',
  google: 'Google',
};

export function DashboardPlatformSelector({
  value,
  onChange,
}: {
  value: DashboardPlatform;
  onChange: (_platform: DashboardPlatform) => void;
}) {
  const t = useTranslations('BrandIdentity.scopeFilters');
  return (
    <Select value={value} onValueChange={(next) => onChange(next as DashboardPlatform)}>
      <SelectTrigger className="w-full sm:w-auto sm:max-w-[160px]">
        <SelectValue placeholder={t('allPlatforms')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('allPlatforms')}</SelectItem>
        <SelectItem value="meta">{PLATFORM_LABELS.meta}</SelectItem>
        <SelectItem value="google">{PLATFORM_LABELS.google}</SelectItem>
      </SelectContent>
    </Select>
  );
}

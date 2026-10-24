'use client';

import Link from 'next/link';
import { Radar } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Chroma } from '@/components/chroma';

export function BrandIdentityEmptyState() {
  const t = useTranslations('BrandIdentity.emptyState');
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="max-w-md text-center">
        <Chroma
          state="idle"
          size={96}
          className="mb-3"
          fallback={<Radar className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />}
        />
        <h3 className="mb-1 text-lg font-medium">{t('title')}</h3>
        <p className="mb-4 text-sm text-muted-foreground">{t('body')}</p>
        <Button asChild>
          <Link href="/brand-identity/competitors">{t('cta')}</Link>
        </Button>
      </div>
    </div>
  );
}

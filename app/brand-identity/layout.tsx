'use client';

import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BRAND_IDENTITY_SECTIONS } from './navigation';

// §7.6's section header: PageHeader plus the section tab row (Adcero's NavTabRow).
// Brand Presence isn't part of Ad Lab, so its tab is left out.
const SECTIONS = BRAND_IDENTITY_SECTIONS.filter((tab) => tab.value !== 'presence');

export default function BrandIdentityLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations('BrandIdentity.nav');
  const active =
    [...SECTIONS].sort((a, b) => b.href.length - a.href.length).find((tab) => pathname.startsWith(tab.href)) ??
    SECTIONS[0];

  return (
    <>
      <PageHeader title={t(active.labelKey)} />
      <Tabs
        value={active.value}
        onValueChange={(value) => {
          const tab = SECTIONS.find((s) => s.value === value);
          if (tab && tab.value !== active.value) router.push(tab.href);
        }}
      >
        <TabsList className="flex w-full justify-start overflow-x-auto sm:w-fit">
          {SECTIONS.map(({ value, labelKey, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="flex flex-none items-center gap-2 px-3">
              <Icon className="h-4 w-4" />
              {t(labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {children}
    </>
  );
}

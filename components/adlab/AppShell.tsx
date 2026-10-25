import type { ReactNode } from 'react';
import { BrandKitBanner } from '@/components/adlab/BrandKitBanner';
import { TopNav } from '@/components/adlab/TopNav';

/** The shell every section behind the landing page sits in: padding, width cap and TopNav.
 * The landing page (app/page.tsx) renders without it so its background can run full-bleed. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background p-6 sm:p-8">
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6">
        <TopNav />
        <BrandKitBanner />
        {children}
      </div>
    </div>
  );
}

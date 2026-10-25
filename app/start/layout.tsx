import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/adlab/AppShell';

export const metadata: Metadata = { title: 'Ad Lab · Brand kit' };

export default function StartLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

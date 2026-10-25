import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/adlab/AppShell';
import { SimProvider } from './_components/SimProvider';

export const metadata: Metadata = { title: 'Ad Lab · Simulation' };

export default function SimLayout({ children }: { children: ReactNode }) {
  return (
    <SimProvider>
      <AppShell>{children}</AppShell>
    </SimProvider>
  );
}

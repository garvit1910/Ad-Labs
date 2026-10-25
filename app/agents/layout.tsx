import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/adlab/AppShell';
import { SimProvider } from '@/app/sim/_components/SimProvider';

// B's SimProvider, reused by import: one live SpacetimeDB connection to the database
// lib/spacetime/config.ts picks (NEXT_PUBLIC_SPACETIMEDB_*).
export const metadata: Metadata = { title: 'Ad Lab · Agent room' };

export default function AgentsLayout({ children }: { children: ReactNode }) {
  return (
    <SimProvider>
      <AppShell>{children}</AppShell>
    </SimProvider>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ORG_STUB, OrganizationContext } from '@/contexts/OrganizationContext';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <OrganizationContext.Provider value={ORG_STUB}>
        {children}
        <Toaster theme="dark" />
      </OrganizationContext.Provider>
    </QueryClientProvider>
  );
}

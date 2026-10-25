'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from '@/lib/spacetime/bindings';
import { SPACETIMEDB_DB_NAME, SPACETIMEDB_URI } from '@/lib/spacetime/config';
import { Skeleton } from '@/components/ui/skeleton';

// One live SpacetimeDB connection for every /sim page. lib/spacetime/config.ts picks the database:
// NEXT_PUBLIC_SPACETIMEDB_* when set (the local bench), Maincloud otherwise. The connection only
// opens in the browser, after mount, so server rendering never opens a WebSocket.
export function SimProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const builder = useMemo(
    () => DbConnection.builder().withUri(SPACETIMEDB_URI).withDatabaseName(SPACETIMEDB_DB_NAME).withLightMode(true),
    [],
  );
  if (!mounted) return <Skeleton className="h-64 w-full" />;
  return <SpacetimeDBProvider connectionBuilder={builder}>{children}</SpacetimeDBProvider>;
}

export const isLocalDatabase = (() => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(SPACETIMEDB_URI).hostname);
  } catch {
    return false;
  }
})();
export const databaseLabel = `${SPACETIMEDB_DB_NAME} @ ${SPACETIMEDB_URI.replace(/^https?:\/\//, '')}`;

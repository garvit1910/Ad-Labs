'use client';

import { useMemo } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from '@/lib/spacetime/bindings';
import { latestRun } from './selectors';

// Every live subscription the /sim views read. A's tables (brand, concept, segment, arm, creative)
// come whole; B's per-run tables are filtered to the selected run (`?run=`, else the newest run).
// Rows push in as the worker writes each sim day: no polling.
export function useSimData(requestedRun: string | null) {
  const conn = useSpacetimeDB();
  const [runs, runsReady] = useTable(tables.run);
  const [brands] = useTable(tables.brand);
  const [segments] = useTable(tables.segment);
  const [arms] = useTable(tables.arm);
  const [creatives] = useTable(tables.creative);
  const [products] = useTable(tables.product);

  const run = useMemo(
    () => (requestedRun ? runs.find((r) => r.runId === requestedRun) : latestRun(runs)),
    [runs, requestedRun],
  );
  const runId = run?.runId ?? '';
  const enabled = runId !== '';
  const [rounds] = useTable(tables.round.where((r) => r.runId.eq(runId)), { enabled });
  const [decisions] = useTable(tables.decision.where((r) => r.runId.eq(runId)), { enabled });
  const [armStats] = useTable(tables.armStat.where((r) => r.runId.eq(runId)), { enabled });
  const [learnings] = useTable(tables.learning.where((r) => r.runId.eq(runId)), { enabled });
  const [shoppers] = useTable(tables.shopper.where((r) => r.runId.eq(runId)), { enabled });

  return { conn, runs, runsReady, run, brands, segments, arms, creatives, products, rounds, decisions, armStats, learnings, shoppers };
}

export type SimData = ReturnType<typeof useSimData>;

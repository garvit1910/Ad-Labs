import { resolveSpacetimeTarget, type SpacetimeTarget } from './spacetime-http';

/*
 * Which SpacetimeDB databases A's agents may run on (docs/PLAN.md "A6"). The creative table has
 * no run column and B's loader reads every run's creatives, so each generating run gets its own
 * database: B's demo run on adlab-calhacks13, the agents' runs on a seeded copy (the local bench
 * for tests, a second Maincloud database for the stage).
 */

/** B's demo run. The agents never start a run or write here. */
export const DEMO_DATABASE = 'adlab-calhacks13';

/** The stage database. Maincloud names are global, so it can be renamed with ADLAB_LIVE_DB_NAME. */
export const LIVE_DATABASE = process.env.ADLAB_LIVE_DB_NAME?.trim() || 'adlab-live';

export const MAINCLOUD_URI = 'https://maincloud.spacetimedb.com';

/** The demo run's database, the default source for seeding a bench. */
export const DEMO_TARGET = { uri: MAINCLOUD_URI, dbName: DEMO_DATABASE } as const;

export const BENCH_TARGETS = {
  local: { uri: 'http://127.0.0.1:3100', dbName: 'adlab-local' },
  live: { uri: MAINCLOUD_URI, dbName: LIVE_DATABASE },
} as const;

export type BenchName = keyof typeof BENCH_TARGETS;

export const benchTarget = (name: BenchName): SpacetimeTarget => resolveSpacetimeTarget(BENCH_TARGETS[name]);

/** Agent runs and agent writes: never the demo database; only localhost or the stage database. */
export const runsAllowed = (target: SpacetimeTarget): boolean =>
  target.dbName !== DEMO_DATABASE && (target.isLocal || target.dbName === LIVE_DATABASE);

export const sameTarget = (a: SpacetimeTarget, b: SpacetimeTarget): boolean => a.uri === b.uri && a.dbName === b.dbName;

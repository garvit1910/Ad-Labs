import type { JobQueueStatus, JobTransition, JobTransitionHook } from '@/worker/loop';
import { LIMITS, type IngestStatus } from '@/spacetime/src/agent_rules';
import { REFRESH_JOB_TYPES } from './ingest-refresh';
import { connectSpacetime, resolveSpacetimeTarget, type Spacetime, type SpacetimeTarget } from './spacetime-http';
import { DEMO_DATABASE } from './targets';

/*
 * The job mirror (docs/PLAN.md A6 "Job mirror"): the job_queue worker reports each claim and
 * finish of a job Scout started, and the job's ingest_job row in SpacetimeDB follows it, so /agents
 * shows a live Apify refresh move pending -> processing -> completed. Opt-in with
 * ADLAB_INGEST_MIRROR=1 (only `npm run worker:live` sets it), never into B's demo database.
 * report_ingest_job only updates rows an endpoint created, so a child job's report is a no-op.
 */

export const MIRROR_ENV = 'ADLAB_INGEST_MIRROR';

/** The job types an endpoint writes ingest_job rows for: Scout's refreshes, and distill's crawl. */
export const MIRRORED_TYPES: ReadonlySet<string> = new Set([...REFRESH_JOB_TYPES, 'brand_object_crawl']);

/** A connect failure waits this long before the next try, so a down database costs one warning a minute. */
const RECONNECT_BACKOFF_MS = 60_000;

/** job_queue status -> ingest_job status: cancelled (a skip) reads skipped; the rest map as they are. */
export function mirrorStatus(status: JobQueueStatus): IngestStatus {
  return status === 'cancelled' ? 'skipped' : status;
}

const clampError = (s: string | null) => {
  const chars = [...(s ?? '')];
  return chars.length > LIMITS.error ? `${chars.slice(0, LIMITS.error - 1).join('')}…` : chars.join('');
};

/** The report_ingest_job arguments for one transition, positional: job_id, status, items, error. */
export function mirrorArgs(t: JobTransition): [string, IngestStatus, number, string] {
  return [t.jobId.toLowerCase(), mirrorStatus(t.to), 0, clampError(t.error)];
}

export interface IngestMirrorOptions {
  env?: NodeJS.ProcessEnv;
  /** The SpacetimeDB connection (tests pass a fake); default connectSpacetime() on the env target. */
  connect?: (target: SpacetimeTarget) => Promise<Spacetime>;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * The worker's onTransition hook, or undefined when the mirror is off (ADLAB_INGEST_MIRROR unset)
 * or refused (the target is B's demo database). Prints which it is, and the target, at startup.
 */
export function createIngestMirror(opts: IngestMirrorOptions = {}): JobTransitionHook | undefined {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const now = opts.now ?? Date.now;
  if (env[MIRROR_ENV]?.trim() !== '1') {
    log(`[worker] ingest mirror off (set ${MIRROR_ENV}=1 to report Scout's jobs to ingest_job)`);
    return undefined;
  }
  // The same target connectSpacetime() picks: SPACETIMEDB_URI / SPACETIMEDB_DB_NAME, else the defaults.
  const target = resolveSpacetimeTarget(env === process.env ? {} : { uri: env.SPACETIMEDB_URI, dbName: env.SPACETIMEDB_DB_NAME });
  if (target.dbName === DEMO_DATABASE) {
    log(`[worker] ingest mirror refused: ${target.label} is B's demo database; agents never write there`);
    return undefined;
  }
  log(`[worker] mirroring ingest jobs to ${target.label}`);

  const connect = opts.connect ?? ((t: SpacetimeTarget) => connectSpacetime({ uri: t.uri, dbName: t.dbName }));
  let connection: Promise<Spacetime> | undefined;
  let retryAt = 0;
  const spacetime = (): Promise<Spacetime> | null => {
    if (connection) return connection;
    if (now() < retryAt) return null;
    connection = connect(target).catch((err: unknown) => {
      connection = undefined;
      retryAt = now() + RECONNECT_BACKOFF_MS;
      throw err;
    });
    return connection;
  };

  return async (t: JobTransition) => {
    if (!MIRRORED_TYPES.has(t.type)) return;
    const pending = spacetime();
    if (!pending) return;
    const st = await pending;
    await st.call('report_ingest_job', mirrorArgs(t));
  };
}

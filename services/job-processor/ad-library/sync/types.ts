/** Chunk size for library_ads upserts and PostgREST `.in()` existence reads. */
export const UPSERT_CHUNK_SIZE = 100;

/**
 * Hard wall-clock ceiling for a single provider run. Staleness is otherwise
 * state-based (pollRun), so a slow-but-alive run is never abandoned early; a
 * run past this ceiling is aborted (stops billing) before the job fails
 * retryable.
 */
export const MAX_RUN_WALL_MS = 60 * 60 * 1000;

export interface CompetitorRow {
  id: string;
  organization_id: string;
  platform: string;
  name: string | null;
  keyword: string | null;
  country: string | null;
  page_ref: string | null;
  meta_page_id: string | null;
  google_advertiser_id: string | null;
  google_advertiser_name: string | null;
  status: string;
  sync_run_id: string | null;
  sync_run_started_at: string | null;
  /** Set on global Industry Explorer catalog seeds; null on real competitors. */
  industry: string | null;
  /** null until the first successful sync — the first-sync (backfill) signal. */
  last_synced_at: string | null;
  /** Agentic slot; holds `adlibCadence` (see cadence.ts) among other keys. */
  scores: Record<string, unknown> | null;
}

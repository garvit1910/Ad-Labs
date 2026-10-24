-- Ad Lab A1: the minimal job_queue of REUSE_MANIFEST §8.4 (a subset of Adcero's
-- drizzle/schema.ts:824) and the two dedupe indexes the copied queue modules
-- rely on. Their names must stay exact: the queues match a 23505 on the index
-- name and reuse the winning row. The local worker (worker/) drains it.
create table job_queue (
  id uuid primary key default gen_random_uuid(), type text not null, dedupe_key text, status text not null default 'pending',
  priority int default 0, payload jsonb not null default '{}', result jsonb, attempts int default 0, max_attempts int default 3,
  error_message text, organization_id uuid, created_at timestamptz default now(), scheduled_for timestamptz default now(),
  started_at timestamptz, completed_at timestamptz, claim_token uuid);

create unique index idx_job_queue_brand_presence_active_dedupe on job_queue (type, dedupe_key) where type like 'brand_presence%' and dedupe_key is not null and status in ('pending','processing');
create unique index idx_job_queue_brand_object_active_dedupe  on job_queue (type, dedupe_key) where type like 'brand_object%'  and dedupe_key is not null and status in ('pending','processing');

revoke all on table public.job_queue from anon, authenticated;
grant all on table public.job_queue to service_role;

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APIFY_AD_LIBRARY_ACTOR_ID } from '@/services/ad-library/apify-config';
import { INSTAGRAM_SCRAPER_ACTOR_ID } from '@/services/brand-presence/instagram-apify-provider';
import { REDDIT_SCRAPER_ACTOR_ID } from '@/services/brand-presence/reddit-apify-provider';
import { TIKTOK_COMMENTS_ACTOR_ID } from '@/services/brand-presence/tiktok-apify-provider';
import { TRUSTPILOT_SCRAPER_ACTOR_ID } from '@/services/brand-presence/trustpilot-apify-provider';
import { X_SCRAPER_ACTOR_ID } from '@/services/brand-presence/x-apify-provider';
import {
  ACTORS,
  DRY_RUN_ERROR,
  type PlannedJob,
  RefreshRequestError,
  ingestStatusOf,
  jobsStatus,
  pageTarget,
  planRefresh,
  refresh,
  selectTargets,
  sourceTarget,
  stalestFirst,
} from '@/lib/adlab/ingest-refresh';
import { MAGIC_SPOON_URL } from '@/lib/adlab/brand-profile';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import type { Spacetime } from '@/lib/adlab/spacetime-http';
import { JOB_ID_RE } from '@/spacetime/src/agent_rules';
import { fakeSupabase } from './fake-supabase';

const PROFILE = 'e7252185-7867-4662-846b-71a57ded35a6';

function world() {
  const org = { organization_id: ADLAB_ORG_ID, brand_profile_id: PROFILE };
  return fakeSupabase({
    brand_presence_profiles: [{ id: PROFILE, organization_id: ADLAB_ORG_ID, website_url: MAGIC_SPOON_URL, status: 'confirmed', brand_name: 'Magic Spoon' }],
    tracked_competitors: [
      { ...org, id: 'p-ms', name: 'Magic Spoon', platform: 'meta', status: 'active', is_brand_self: true, last_synced_at: '2026-10-24T22:32:23.253+00:00' },
      { ...org, id: 'p-cc', name: 'Catalina Crunch', platform: 'meta', status: 'active', last_synced_at: '2026-10-24T22:30:00.000+00:00' },
      { ...org, id: 'p-new', name: 'Seven Sundays', platform: 'meta', status: 'active', last_synced_at: null },
      { ...org, id: 'p-paused', name: 'Paused Brand', platform: 'meta', status: 'paused', last_synced_at: null },
      { ...org, id: 'p-google', name: 'Google Brand', platform: 'google', status: 'active', last_synced_at: null },
    ],
    brand_presence_sources: [
      { ...org, id: 's-keto', source_type: 'reddit_subreddit', label: 'r/keto (core)', uri: 'r/keto', last_synced_at: '2026-10-24T22:00:00.000+00:00' },
      { ...org, id: 's-tp', source_type: 'trustpilot', label: 'Trustpilot — Magicspoon', uri: '', last_synced_at: '2026-10-24T21:00:00.000+00:00' },
      { ...org, id: 's-amz', source_type: 'amazon_reviews', label: 'Amazon Reviews', uri: '', last_synced_at: '2026-10-24T20:00:00.000+00:00' },
      { ...org, id: 's-never', source_type: 'x', label: 'X (Twitter)', uri: '', last_synced_at: null },
    ],
    job_queue: [],
  });
}

class FakeSpacetime implements Spacetime {
  readonly label = 'fake';
  calls: Array<{ reducer: string; args: unknown[] }> = [];
  ingest: Array<Record<string, unknown>> = [];
  async call(reducer: string, args: unknown[]) {
    this.calls.push({ reducer, args });
    if (reducer === 'upsert_ingest_job') {
      const [job_id, requested_by, job_type, target, actor, status, items, error] = args;
      this.ingest = this.ingest.filter((r) => r.job_id !== job_id);
      this.ingest.push({ job_id, requested_by, job_type, target, actor, status, items, error });
    }
  }
  async sql<T>(query: string) {
    assert.equal(query, 'SELECT * FROM ingest_job');
    return this.ingest as T[];
  }
}

describe('stalestFirst', () => {
  it('puts never-synced rows first, then the oldest, then the ref id', () => {
    const rows = [
      { ref_id: 'b', last_synced_at: '2026-10-24T10:00:00Z' },
      { ref_id: 'z', last_synced_at: null },
      { ref_id: 'a', last_synced_at: '2026-10-24T10:00:00Z' },
      { ref_id: 'c', last_synced_at: '2026-10-23T10:00:00Z' },
      { ref_id: 'y', last_synced_at: null },
    ];
    assert.deepEqual(
      stalestFirst(rows).map((r) => r.ref_id),
      ['y', 'z', 'c', 'a', 'b'],
    );
  });
});

describe('ACTORS', () => {
  it('uses the provider constants as they are, with a readable ad library actor', () => {
    assert.equal(ACTORS.adlib_sync_competitor!.apifyId, APIFY_AD_LIBRARY_ACTOR_ID);
    assert.equal(ACTORS.adlib_sync_competitor!.actor, 'curious_coder~facebook-ads-library-scraper');
    assert.equal(ACTORS.brand_presence_reddit_scrape!.actor, REDDIT_SCRAPER_ACTOR_ID);
    assert.equal(ACTORS.brand_presence_x_scrape!.actor, X_SCRAPER_ACTOR_ID);
    assert.equal(ACTORS.brand_presence_trustpilot_reviews!.actor, TRUSTPILOT_SCRAPER_ACTOR_ID);
    assert.equal(ACTORS.brand_presence_tiktok_comments!.actor, TIKTOK_COMMENTS_ACTOR_ID);
    assert.equal(ACTORS.brand_presence_instagram_comments!.actor, INSTAGRAM_SCRAPER_ACTOR_ID);
    assert.equal(REDDIT_SCRAPER_ACTOR_ID, 'trudax~reddit-scraper-lite');
  });
});

describe('targets', () => {
  it('reads "<brand> · Meta ads" and "<platform> · <detail>"', () => {
    assert.equal(pageTarget('Catalina Crunch'), 'Catalina Crunch · Meta ads');
    assert.equal(sourceTarget({ source_type: 'reddit_subreddit', label: 'r/keto (core)', uri: 'r/keto' }, 'Magic Spoon'), 'Reddit · r/keto');
    assert.equal(sourceTarget({ source_type: 'reddit_search', label: 'Reddit — brand mentions', uri: '' }, 'Magic Spoon'), 'Reddit · brand mentions');
    assert.equal(sourceTarget({ source_type: 'tiktok_comments', label: 'TikTok — @magicspooncereal', uri: '' }, 'Magic Spoon'), 'TikTok · @magicspooncereal');
    assert.equal(sourceTarget({ source_type: 'x', label: 'X (Twitter)', uri: '' }, 'Magic Spoon'), 'X · Magic Spoon');
  });
});

describe('planRefresh', () => {
  it('plans active Meta pages (self included) and synced live sources, stalest first, reading only', async () => {
    const { db, ops } = world();
    const planned = await planRefresh(db);
    assert.deepEqual(
      planned.map((p) => [p.kind, p.ref_id, p.target]),
      [
        ['page', 'p-new', 'Seven Sundays · Meta ads'],
        ['source', 's-tp', 'Trustpilot · Magicspoon'],
        ['source', 's-keto', 'Reddit · r/keto'],
        ['page', 'p-cc', 'Catalina Crunch · Meta ads'],
        ['page', 'p-ms', 'Magic Spoon · Meta ads'],
      ],
    );
    const keto = planned.find((p) => p.ref_id === 's-keto')!;
    assert.equal(keto.job_type, 'brand_presence_reddit_scrape');
    assert.equal(keto.actor, REDDIT_SCRAPER_ACTOR_ID);
    assert.equal(planned.find((p) => p.ref_id === 'p-cc')!.job_type, 'adlib_sync_competitor');
    assert.ok(ops.every((o) => o.op === 'select'));
    assert.ok(!ops.some((o) => o.table === 'job_queue'));
  });
});

describe('selectTargets', () => {
  const plan: PlannedJob[] = [
    { kind: 'page', target: 'A · Meta ads', actor: 'x', job_type: 'adlib_sync_competitor', ref_id: 'p1', last_synced_at: null },
    { kind: 'source', target: 'Reddit · r/keto', actor: 'y', job_type: 'brand_presence_reddit_scrape', ref_id: 's1', last_synced_at: null },
    { kind: 'page', target: 'B · Meta ads', actor: 'x', job_type: 'adlib_sync_competitor', ref_id: 'p2', last_synced_at: null },
    { kind: 'page', target: 'C · Meta ads', actor: 'x', job_type: 'adlib_sync_competitor', ref_id: 'p3', last_synced_at: null },
  ];
  it('defaults to 2 pages and 1 source, stalest first', () => {
    assert.deepEqual(
      selectTargets(plan, {}).map((p) => p.ref_id),
      ['p1', 'p2', 's1'],
    );
    assert.deepEqual(
      selectTargets(plan, { pages: 0, sources: 0 }).map((p) => p.ref_id),
      [],
    );
  });
  it('takes named targets and refuses unknown ones', () => {
    assert.deepEqual(
      selectTargets(plan, { targets: [{ kind: 'page', ref_id: 'p3' }] }).map((p) => p.ref_id),
      ['p3'],
    );
    assert.throws(() => selectTargets(plan, { targets: [{ kind: 'source', ref_id: 'p3' }] }), RefreshRequestError);
  });
});

describe('refresh', () => {
  it('dry: returns the whole plan and writes nothing', async () => {
    const { db, ops } = world();
    const st = new FakeSpacetime();
    const result = await refresh(db, async () => assert.fail('a dry plan never connects') as never, { requested_by: 'agt_scout', dry: true, mode: 'test' });
    assert.equal(result.mode, 'test');
    assert.equal(result.planned.length, 5);
    assert.deepEqual(result.jobs, []);
    assert.equal(st.calls.length, 0);
    assert.ok(ops.every((o) => o.op === 'select'));
  });

  it('test mode: writes only skipped ingest_job rows and never touches job_queue', async () => {
    const { db, ops, tables } = world();
    const st = new FakeSpacetime();
    const result = await refresh(db, st, { requested_by: 'agt_scout', pages: 2, sources: 1, mode: 'test' });
    assert.equal(result.jobs.length, 3);
    assert.deepEqual(
      result.planned.map((p) => p.ref_id),
      ['p-new', 'p-cc', 's-tp'],
    );
    assert.deepEqual(
      st.calls.map((c) => c.reducer),
      ['upsert_ingest_job', 'upsert_ingest_job', 'upsert_ingest_job'],
    );
    for (const [i, call] of st.calls.entries()) {
      const [jobId, requestedBy, jobType, target, actor, status, items, error] = call.args;
      assert.match(String(jobId), JOB_ID_RE);
      assert.equal(requestedBy, 'agt_scout');
      assert.equal(jobType, result.planned[i]!.job_type);
      assert.equal(target, result.planned[i]!.target);
      assert.equal(actor, result.planned[i]!.actor);
      assert.equal(status, 'skipped');
      assert.equal(items, 0);
      assert.equal(error, DRY_RUN_ERROR);
      assert.deepEqual(result.jobs[i], { job_id: jobId, target, actor, status: 'skipped', dry: true, deduped: false });
    }
    assert.ok(!ops.some((o) => o.table === 'job_queue'), 'job_queue is never read or written');
    assert.ok(ops.every((o) => o.op === 'select'), 'Supabase is only read');
    assert.equal(tables.job_queue!.length, 0);
  });

  it('live mode: enqueues, writes pending rows, keeps a deduped row through report_ingest_job, and reconciles', async () => {
    const { db, tables } = world();
    const st = new FakeSpacetime();
    const known = '11111111-1111-4111-8111-111111111111';
    const fresh = '22222222-2222-4222-8222-222222222222';
    st.ingest.push({ job_id: known, requested_by: 'agt_scout', job_type: 'adlib_sync_competitor', target: 'Seven Sundays · Meta ads', actor: 'a', status: 'processing', items: 0, error: '' });
    tables.job_queue!.push({ id: known, type: 'adlib_sync_competitor', status: 'processing', error_message: null }, { id: fresh, type: 'adlib_sync_competitor', status: 'pending', error_message: null });
    const enqueued: string[] = [];
    const result = await refresh(
      db,
      st,
      { requested_by: 'agt_scout', pages: 2, sources: 0, mode: 'live' },
      {
        enqueue: async (_db, job) => {
          enqueued.push(job.ref_id);
          return job.ref_id === 'p-new' ? { jobId: known, deduped: true } : { jobId: fresh, deduped: false };
        },
      },
    );
    assert.deepEqual(enqueued, ['p-new', 'p-cc']);
    assert.deepEqual(
      st.calls.map((c) => [c.reducer, c.args[0], c.reducer === 'upsert_ingest_job' ? c.args[5] : c.args[1]]),
      [
        ['upsert_ingest_job', fresh, 'pending'],
        ['report_ingest_job', known, 'processing'],
      ],
    );
    assert.deepEqual(
      result.jobs.map((j) => [j.job_id, j.status, j.deduped, j.dry]),
      [
        [known, 'processing', true, false],
        [fresh, 'pending', false, false],
      ],
    );
  });
});

describe('jobsStatus', () => {
  it('merges job_queue with ingest_job; cancelled reads skipped; dry ids come from ingest_job', async () => {
    const { db, tables } = world();
    const st = new FakeSpacetime();
    const live = '33333333-3333-4333-8333-333333333333';
    const dry = '44444444-4444-4444-8444-444444444444';
    tables.job_queue!.push({ id: live, type: 'adlib_sync_competitor', status: 'cancelled', error_message: null, attempts: 1 });
    st.ingest.push(
      { job_id: live, requested_by: 'agt_scout', job_type: 'adlib_sync_competitor', target: 'GHOST · Meta ads', actor: 'curious_coder~facebook-ads-library-scraper', status: 'pending', items: 4, error: '' },
      { job_id: dry, requested_by: 'agt_scout', job_type: 'brand_presence_reddit_scrape', target: 'Reddit · r/keto', actor: REDDIT_SCRAPER_ACTOR_ID, status: 'skipped', items: 0, error: DRY_RUN_ERROR },
    );
    const { jobs } = await jobsStatus(db, st, [live.toUpperCase(), dry, '55555555-5555-4555-8555-555555555555']);
    assert.deepEqual(jobs, [
      { job_id: live, job_type: 'adlib_sync_competitor', status: 'skipped', error: '', items: 4, target: 'GHOST · Meta ads', actor: 'curious_coder~facebook-ads-library-scraper', attempts: 1 },
      { job_id: dry, job_type: 'brand_presence_reddit_scrape', status: 'skipped', error: DRY_RUN_ERROR, items: 0, target: 'Reddit · r/keto', actor: REDDIT_SCRAPER_ACTOR_ID, attempts: 0 },
    ]);
  });

  it('maps queue statuses', () => {
    assert.equal(ingestStatusOf('cancelled'), 'skipped');
    assert.equal(ingestStatusOf('processing'), 'processing');
    assert.equal(ingestStatusOf('weird'), 'pending');
  });
});

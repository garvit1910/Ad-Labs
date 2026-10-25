import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { type JobTransition, runWorker, safeNotify } from '@/worker/loop';
import { FROZEN_BRAND_OBJECT_REASON, SKIPPED_JOB_TYPES, skipReasonFor } from '@/worker/registry';
import { fakeSupabase } from '../lib/adlab/fake-supabase';

const t: JobTransition = { jobId: '66666666-6666-4666-8666-666666666666', type: 'adlib_sync_competitor', from: 'pending', to: 'processing', error: null, attempts: 1 };

describe('ADLAB_FREEZE_BRAND_OBJECT', () => {
  const saved = process.env.ADLAB_FREEZE_BRAND_OBJECT;
  afterEach(() => {
    if (saved === undefined) delete process.env.ADLAB_FREEZE_BRAND_OBJECT;
    else process.env.ADLAB_FREEZE_BRAND_OBJECT = saved;
  });

  it('skips every brand_object_* type only when set to 1', () => {
    for (const type of ['brand_object_market', 'brand_object_personas', 'brand_object_promote', 'brand_object_identity', 'brand_object_crawl', 'brand_object_chunks']) {
      assert.equal(skipReasonFor(type, {}), undefined);
      assert.equal(skipReasonFor(type, { ADLAB_FREEZE_BRAND_OBJECT: '0' }), undefined);
      assert.equal(skipReasonFor(type, { ADLAB_FREEZE_BRAND_OBJECT: '1' }), FROZEN_BRAND_OBJECT_REASON);
    }
    assert.equal(skipReasonFor('adlib_sync_competitor', { ADLAB_FREEZE_BRAND_OBJECT: '1' }), undefined);
    assert.equal(skipReasonFor('brand_presence_reddit_scrape', { ADLAB_FREEZE_BRAND_OBJECT: '1' }), undefined);
    const [rehost, reason] = Object.entries(SKIPPED_JOB_TYPES)[0]!;
    assert.equal(skipReasonFor(rehost, {}), reason);
  });

  it('the worker marks a frozen job cancelled as skipped, never runs it, and reports both transitions', async () => {
    process.env.ADLAB_FREEZE_BRAND_OBJECT = '1';
    const id = '77777777-7777-4777-8777-777777777777';
    const { db, tables } = fakeSupabase({
      job_queue: [{ id, type: 'brand_object_market', status: 'pending', attempts: 0, max_attempts: 3, scheduled_for: '2000-01-01T00:00:00.000Z', payload: { organizationId: 'x' } }],
    });
    const seen: JobTransition[] = [];
    const counts = await runWorker(db, { onTransition: async (tr) => void seen.push(tr) });
    assert.deepEqual(counts, { completed: 0, failed: 0, requeued: 0, skipped: 1 });
    const row = tables.job_queue![0]!;
    assert.equal(row.status, 'cancelled');
    assert.deepEqual(row.result, { skipped: FROZEN_BRAND_OBJECT_REASON });
    assert.deepEqual(
      seen.map((s) => [s.jobId, s.type, s.from, s.to, s.error]),
      [
        [id, 'brand_object_market', 'pending', 'processing', null],
        [id, 'brand_object_market', 'processing', 'cancelled', FROZEN_BRAND_OBJECT_REASON],
      ],
    );
  });

  it('a throwing hook never fails the job', async () => {
    process.env.ADLAB_FREEZE_BRAND_OBJECT = '1';
    const { db, tables } = fakeSupabase({
      job_queue: [{ id: '88888888-8888-4888-8888-888888888888', type: 'brand_object_personas', status: 'pending', attempts: 0, max_attempts: 3, scheduled_for: '2000-01-01T00:00:00.000Z', payload: {} }],
    });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => void warnings.push(line);
    try {
      const counts = await runWorker(db, {
        onTransition: async () => {
          throw new Error('mirror down');
        },
      });
      assert.equal(counts.skipped, 1);
    } finally {
      console.warn = original;
    }
    assert.equal(tables.job_queue![0]!.status, 'cancelled');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /mirror down/);
  });
});

describe('safeNotify', () => {
  it('does nothing without a hook', async () => {
    await safeNotify(undefined, t);
  });

  it('swallows a throw (sync or async) and warns', async () => {
    const warnings: string[] = [];
    await safeNotify(
      () => {
        throw new Error('boom');
      },
      t,
      { warn: (l) => warnings.push(l) },
    );
    await safeNotify(async () => Promise.reject(new Error('async boom')), t, { warn: (l) => warnings.push(l) });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /boom/);
    assert.match(warnings[1]!, /async boom/);
  });

  it('gives up on a hanging hook after the timeout', async () => {
    const warnings: string[] = [];
    const started = Date.now();
    await safeNotify(() => new Promise<void>(() => {}), t, { timeoutMs: 50, warn: (l) => warnings.push(l) });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /timed out/);
  });

  it('passes the transition through', async () => {
    let got: JobTransition | undefined;
    await safeNotify(async (tr) => void (got = tr), t, { warn: () => assert.fail('no warning') });
    assert.deepEqual(got, t);
  });
});

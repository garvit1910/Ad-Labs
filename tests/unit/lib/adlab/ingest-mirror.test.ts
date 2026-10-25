import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIRRORED_TYPES, createIngestMirror, mirrorArgs, mirrorStatus } from '@/lib/adlab/ingest-mirror';
import type { Spacetime } from '@/lib/adlab/spacetime-http';
import { DEMO_DATABASE } from '@/lib/adlab/targets';
import type { JobTransition } from '@/worker/loop';

const LOCAL = { SPACETIMEDB_URI: 'http://127.0.0.1:3100', SPACETIMEDB_DB_NAME: 'adlab-local' };
const tr = (over: Partial<JobTransition> = {}): JobTransition => ({
  jobId: '9A9A9A9A-9A9A-4A9A-8A9A-9A9A9A9A9A9A',
  type: 'adlib_sync_competitor',
  from: 'pending',
  to: 'processing',
  error: null,
  attempts: 1,
  ...over,
});

function fakeConnect() {
  const calls: Array<{ reducer: string; args: unknown[] }> = [];
  let connects = 0;
  const connect = async () => {
    connects++;
    return { label: 'fake', call: async (reducer: string, args: unknown[]) => void calls.push({ reducer, args }), sql: async () => [] } as Spacetime;
  };
  return { calls, connect, connects: () => connects };
}

describe('mirrorStatus', () => {
  it('maps job_queue statuses to ingest_job statuses', () => {
    assert.equal(mirrorStatus('processing'), 'processing');
    assert.equal(mirrorStatus('completed'), 'completed');
    assert.equal(mirrorStatus('failed'), 'failed');
    assert.equal(mirrorStatus('pending'), 'pending');
    assert.equal(mirrorStatus('cancelled'), 'skipped');
  });

  it('builds report_ingest_job args: lowercase id, status, 0 items, the error clamped', () => {
    assert.deepEqual(mirrorArgs(tr({ to: 'cancelled', error: 'frozen' })), ['9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a', 'skipped', 0, 'frozen']);
    const [, , , error] = mirrorArgs(tr({ to: 'failed', error: 'x'.repeat(2000) }));
    assert.equal([...error].length, 1000);
  });
});

describe('createIngestMirror', () => {
  it('is off unless ADLAB_INGEST_MIRROR=1', () => {
    const lines: string[] = [];
    assert.equal(createIngestMirror({ env: { ...LOCAL }, log: (l) => lines.push(l) }), undefined);
    assert.equal(createIngestMirror({ env: { ...LOCAL, ADLAB_INGEST_MIRROR: '0' }, log: (l) => lines.push(l) }), undefined);
    assert.match(lines[0]!, /ingest mirror off/);
  });

  it("refuses B's demo database", () => {
    const lines: string[] = [];
    const hook = createIngestMirror({
      env: { ADLAB_INGEST_MIRROR: '1', SPACETIMEDB_URI: 'https://maincloud.spacetimedb.com', SPACETIMEDB_DB_NAME: DEMO_DATABASE },
      log: (l) => lines.push(l),
      connect: async () => assert.fail('never connects'),
    });
    assert.equal(hook, undefined);
    assert.match(lines[0]!, /refused/);
  });

  it('prints its target, connects lazily once, and reports only mirrored types', async () => {
    const lines: string[] = [];
    const fake = fakeConnect();
    const hook = createIngestMirror({ env: { ...LOCAL, ADLAB_INGEST_MIRROR: '1' }, log: (l) => lines.push(l), connect: fake.connect });
    assert.ok(hook);
    assert.equal(lines[0], '[worker] mirroring ingest jobs to http://127.0.0.1:3100 / adlab-local (LOCAL)');
    assert.equal(fake.connects(), 0);
    await hook(tr({ type: 'adlib_label_batch' }));
    assert.equal(fake.connects(), 0, 'child jobs never connect');
    await hook(tr());
    await hook(tr({ from: 'processing', to: 'completed' }));
    await hook(tr({ type: 'brand_presence_reddit_scrape', from: 'processing', to: 'cancelled', error: 'skipped' }));
    assert.equal(fake.connects(), 1);
    assert.deepEqual(fake.calls, [
      { reducer: 'report_ingest_job', args: ['9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a', 'processing', 0, ''] },
      { reducer: 'report_ingest_job', args: ['9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a', 'completed', 0, ''] },
      { reducer: 'report_ingest_job', args: ['9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a', 'skipped', 0, 'skipped'] },
    ]);
    assert.ok(MIRRORED_TYPES.has('brand_object_crawl'));
  });

  it('backs off after a connect failure', async () => {
    let now = 0;
    let attempts = 0;
    const hook = createIngestMirror({
      env: { ...LOCAL, ADLAB_INGEST_MIRROR: '1' },
      log: () => {},
      now: () => now,
      connect: async () => {
        attempts++;
        throw new Error('down');
      },
    })!;
    await assert.rejects(hook(tr()), /down/);
    await hook(tr());
    assert.equal(attempts, 1, 'no retry inside the backoff');
    now = 61_000;
    await assert.rejects(hook(tr()), /down/);
    assert.equal(attempts, 2);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CopywriterError, failForCopywriter, generateForCopywriter } from '@/lib/adlab/copywriter';
import type { SqlRow } from '@/lib/adlab/spacetime-http';
import { ClaimLostError, type TaskOptions, type TaskResult } from '@/worker/creatives/run';
import { FakeStdb } from '../../worker/creatives/helpers';

const TASK = 'tsk_gen_run_cw_r0';

const task = (overrides: SqlRow = {}): SqlRow => ({
  task_id: TASK,
  run_id: 'run_cw',
  kind: 'generate_creatives',
  payload: JSON.stringify({ run_id: 'run_cw', round: 0, arms: [], n_per_arm: 1, learning_ids: [] }),
  status: 'queued',
  claimed_by: null,
  result: null,
  created_at: '2026-10-25T07:00:00.000Z',
  updated_at: '2026-10-25T07:00:00.000Z',
  ...overrides,
});

const RESULT: TaskResult = {
  round_created: 1,
  written: 2,
  reused: 0,
  ranked: 2,
  gated_out: 0,
  creative_ids: ['cr_a', 'cr_b'],
  skips: [],
  errors: [],
  next_task: 'tsk_run_run_cw_r1',
  learning_ids_applied: ['lrn_x'],
};

const quiet = () => {};
const reducers = (db: FakeStdb) => db.reducerCalls.map((call) => call.reducer);

describe('generateForCopywriter', () => {
  it('runs as copywriter with the chosen learnings and next round, and returns learning_ids_applied', async () => {
    const db = new FakeStdb({ task: [task()] });
    let seen: { taskId: string; opts: TaskOptions } | undefined;
    const run = async (taskId: string, opts: TaskOptions = {}) => {
      seen = { taskId, opts };
      return RESULT;
    };
    const out = await generateForCopywriter({ task_id: TASK, learning_ids: ['lrn_x'], next_round: 'skip' }, { spacetime: db, run, log: quiet });
    assert.equal(seen?.taskId, TASK);
    assert.equal(seen?.opts.claimedBy, 'copywriter');
    assert.deepEqual(seen?.opts.learningIds, ['lrn_x']);
    assert.equal(seen?.opts.nextRound, 'skip');
    assert.deepEqual(out, RESULT);
    // A stored result from before the field existed still answers with it.
    const old = await generateForCopywriter({ task_id: TASK }, { spacetime: db, run: async () => ({ ...RESULT, learning_ids_applied: undefined }), log: quiet });
    assert.deepEqual(old.learning_ids_applied, []);
  });

  it('joins a call already running for the same task instead of starting another', async () => {
    const db = new FakeStdb({ task: [task()] });
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const run = async () => {
      calls++;
      await gate;
      return RESULT;
    };
    const first = generateForCopywriter({ task_id: TASK }, { spacetime: db, run, log: quiet });
    const second = generateForCopywriter({ task_id: TASK }, { spacetime: db, run, log: quiet });
    assert.equal(first, second);
    release();
    assert.deepEqual(await Promise.all([first, second]), [RESULT, RESULT]);
    assert.equal(calls, 1);
    // Settled: the next call runs again.
    await generateForCopywriter({ task_id: TASK }, { spacetime: db, run, log: quiet });
    assert.equal(calls, 2);
  });

  it('answers claim_lost on a lost claim, and never fails the task', async () => {
    const db = new FakeStdb({ task: [task({ status: 'claimed', claimed_by: 'creative_worker' })] });
    const run = async () => {
      throw new ClaimLostError(TASK, 'held by creative_worker');
    };
    await assert.rejects(generateForCopywriter({ task_id: TASK }, { spacetime: db, run, log: quiet }), (err: unknown) => err instanceof CopywriterError && err.code === 'claim_lost');
    assert.ok(!reducers(db).includes('fail_task'));
    assert.equal(db.tables.task[0].status, 'claimed');
  });

  it('answers generate_failed on any other throw, leaving the task claimed by the Copywriter', async () => {
    const db = new FakeStdb({ task: [task()] });
    const run = async (taskId: string, opts: TaskOptions = {}) => {
      await opts.spacetime!.call('claim_task', [taskId, opts.claimedBy]);
      throw new Error('copywriter unavailable: 429');
    };
    await assert.rejects(
      generateForCopywriter({ task_id: TASK }, { spacetime: db, run, log: quiet }),
      (err: unknown) => err instanceof CopywriterError && err.code === 'generate_failed' && /429/.test(err.message),
    );
    assert.deepEqual(reducers(db), ['claim_task']);
    assert.equal(db.tables.task[0].status, 'claimed');
    assert.equal(db.tables.task[0].claimed_by, 'copywriter');

    // Then the Copywriter gives up: /creatives/fail fails it, because it still holds it.
    assert.deepEqual(await failForCopywriter(db, TASK, 'gave up after 3 retries'), { failed: true });
    assert.equal(db.tables.task[0].status, 'failed');
    assert.deepEqual(await failForCopywriter(db, TASK, 'again'), { failed: false });
  });

  it('answers task_not_found and bad_request before running anything', async () => {
    const db = new FakeStdb({ task: [task({ task_id: 'tsk_run_run_cw_r0', kind: 'run_round' })] });
    let calls = 0;
    const run = async () => {
      calls++;
      return RESULT;
    };
    await assert.rejects(generateForCopywriter({ task_id: TASK }, { spacetime: db, run, log: quiet }), (err: unknown) => err instanceof CopywriterError && err.code === 'task_not_found');
    await assert.rejects(
      generateForCopywriter({ task_id: 'tsk_run_run_cw_r0' }, { spacetime: db, run, log: quiet }),
      (err: unknown) => err instanceof CopywriterError && err.code === 'bad_request',
    );
    assert.equal(calls, 0);
  });

  it('never fails a task someone else holds', async () => {
    const db = new FakeStdb({ task: [task({ status: 'claimed', claimed_by: 'creative_worker' })] });
    assert.deepEqual(await failForCopywriter(db, TASK, 'boom'), { failed: false });
    assert.equal(db.tables.task[0].status, 'claimed');
  });
});

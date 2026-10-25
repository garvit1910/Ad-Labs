import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { SqlRow } from '@/lib/adlab/spacetime-http';
import { SpacetimeError } from '@/lib/adlab/spacetime-http';
import { runCreativeTaskLoop } from '@/worker/creatives/loop';
import { ClaimLostError, failTask, runGenerateCreatives, type TaskResult } from '@/worker/creatives/run';
import { a4Tables, briefFixture, CLEAN_COPY, FakeStdb, mockChat, SEG_TRACKER, SEG_UNAWARE, testRows } from './helpers';

const RUN_ID = 'run_test';
const TASK_ID = `tsk_gen_${RUN_ID}_r0`;
const OBJECTION = 'lrn_test_the_macro_tracker_objection_taste_v1';
const STATISTIC_TRACKER = 'cr_g1_test_health_nutrition_statistic_the_macro_tracker_1';

const payload = (round = 0) => ({
  run_id: RUN_ID,
  round,
  arms: [
    { arm_id: 'arm_health_nutrition_statistic', segment_ids: [SEG_TRACKER, SEG_UNAWARE] },
    { arm_id: 'arm_taste_indulgence_testimonial', segment_ids: [SEG_TRACKER, SEG_UNAWARE] },
    { arm_id: 'arm_control', segment_ids: [SEG_TRACKER] },
  ],
  n_per_arm: 1,
  learning_ids: [OBJECTION, 'lrn_test_the_macro_tracker_winner_pov_v1', 'lrn_test_unaware_projection_numbers_v1'],
});

const taskRow = (overrides: SqlRow = {}): SqlRow => ({
  task_id: TASK_ID,
  run_id: RUN_ID,
  kind: 'generate_creatives',
  payload: JSON.stringify(payload()),
  status: 'queued',
  claimed_by: null,
  result: null,
  created_at: '2026-10-24T20:00:00.000Z',
  updated_at: '2026-10-24T20:00:00.000Z',
  ...overrides,
});

function board(tasks: SqlRow[] = [taskRow()], roundsPlanned = 5, extraCreatives: SqlRow[] = []) {
  const tables = a4Tables();
  return new FakeStdb({
    ...tables,
    creative: [...tables.creative, ...extraCreatives],
    run: [{ run_id: RUN_ID, rounds_planned: roundsPlanned }],
    learning: [
      { learning_id: OBJECTION, run_id: RUN_ID, segment_id: SEG_TRACKER, arm_id: null, directive: 'Address taste doubts early for The Macro Tracker.' },
      {
        learning_id: 'lrn_test_the_macro_tracker_winner_pov_v1',
        run_id: RUN_ID,
        segment_id: SEG_TRACKER,
        arm_id: 'arm_convenience_pov_relatable',
        directive: 'For The Macro Tracker, keep leading with convenience through a pov relatable hook.',
      },
      { learning_id: 'lrn_test_unaware_projection_numbers_v1', run_id: RUN_ID, segment_id: SEG_UNAWARE, arm_id: null, directive: 'Mention that 30% stayed.' },
    ],
    task: tasks,
  });
}

const client = () => ({ brandProfileId: briefFixture.briefs[0].pack.meta.brandProfileId as string, rows: testRows(), dropped: 0 });
const quiet = () => {};
const reducers = (db: FakeStdb) => db.reducerCalls.map((call) => call.reducer);
let restore = () => {};
afterEach(() => restore());

describe('runGenerateCreatives', () => {
  it('turns a queued task into run-tagged creative rows, a queued run_round and a done task', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const db = board();
    const result = await runGenerateCreatives(TASK_ID, { spacetime: db, client: client(), log: quiet });

    assert.deepEqual(reducers(db), ['claim_task', 'upsert_creatives', 'enqueue_task', 'complete_task']);
    assert.equal(result.round_created, 1);
    assert.equal(result.ranked, 3);
    assert.deepEqual([...result.creative_ids].sort(), [
      STATISTIC_TRACKER,
      'cr_g1_test_health_nutrition_statistic_unaware_projection_1',
      'cr_g1_test_taste_indulgence_testimonial_the_macro_tracker_1',
    ]);
    assert.deepEqual(
      result.skips.map((skip) => `${skip.arm_id}/${skip.segment_id}: ${skip.missing}`),
      ['arm_taste_indulgence_testimonial/seg_unaware_projection: customer_verbatim', 'arm_control/seg_the_macro_tracker: control_arm'],
    );

    const written = db.tables.creative.filter((creative) => creative.origin === 'generated');
    assert.equal(written.length, 3);
    for (const row of written) {
      assert.equal(row.brand_id, 'br_halden_oat_co');
      assert.equal(row.landing_product_id, 'prd_halden_box');
      assert.equal(row.round_created, 1);
      assert.equal(row.image_url, '');
      assert.equal(row.days_running, 0);
      assert.equal(row.status, 'ranked');
      // The segment-wide objection reaches the tracker's creatives; the other arm's winner and the
      // directive with a number reach none.
      assert.equal(row.learning_ids, row.segment_id === SEG_TRACKER ? JSON.stringify([OBJECTION]) : '[]');
    }
    const notes = chat.calls.map((call) => call.messages[1].content.includes('Notes from testing:\n- Address taste doubts early'));
    assert.equal(notes.filter(Boolean).length, 2);
    assert.ok(chat.calls.every((call) => !call.messages[1].content.includes('pov relatable hook')));

    const tasks = Object.fromEntries(db.tables.task.map((task) => [task.task_id, task]));
    assert.equal(tasks[TASK_ID].status, 'done');
    assert.deepEqual(JSON.parse(String(tasks[TASK_ID].result)), result);
    assert.equal(tasks[`tsk_run_${RUN_ID}_r1`].kind, 'run_round');
    assert.deepEqual(JSON.parse(String(tasks[`tsk_run_${RUN_ID}_r1`].payload)), { run_id: RUN_ID, round: 1 });
    assert.equal(result.next_task, `tsk_run_${RUN_ID}_r1`);
  });

  it('returns a done task’s stored result without generating again', async () => {
    const stored: Partial<TaskResult> = { round_created: 1, written: 3 };
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const db = board([taskRow({ status: 'done', claimed_by: 'copywriter', result: JSON.stringify(stored) })]);
    assert.deepEqual(await runGenerateCreatives(TASK_ID, { spacetime: db, client: client(), log: quiet }), stored);
    assert.equal(chat.calls.length, 0);
    assert.equal(db.reducerCalls.length, 0);
  });

  it('resumes its own claim, keeps what it already wrote, and treats an already-queued run_round as queued', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const queued = taskRow({ task_id: `tsk_run_${RUN_ID}_r1`, kind: 'run_round', payload: JSON.stringify({ run_id: RUN_ID, round: 1 }) });
    const earlier = { ...a4Tables().creative[0], creative_id: STATISTIC_TRACKER, arm_id: 'arm_health_nutrition_statistic', origin: 'generated', round_created: 1, segment_id: SEG_TRACKER, headline: 'Written before the crash' };
    const db = board([taskRow({ status: 'claimed', claimed_by: 'creative_worker' }), queued], 5, [earlier]);
    const result = await runGenerateCreatives(TASK_ID, { spacetime: db, client: client(), log: quiet });
    assert.equal(result.next_task, `tsk_run_${RUN_ID}_r1`);
    assert.deepEqual(reducers(db), ['upsert_creatives', 'enqueue_task', 'complete_task']);
    assert.equal(result.reused, 1);
    assert.equal(result.written, 2);
    assert.equal(chat.calls.length, 2);
    assert.equal(db.tables.creative.find((creative) => creative.creative_id === STATISTIC_TRACKER)?.headline, 'Written before the crash');
    assert.equal(db.tables.task.find((task) => task.task_id === TASK_ID)?.status, 'done');
  });

  it('leaves a task someone else holds alone, unless taking over', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const db = board([taskRow({ status: 'claimed', claimed_by: 'copywriter' })]);
    await assert.rejects(runGenerateCreatives(TASK_ID, { spacetime: db, client: client(), log: quiet }), ClaimLostError);
    assert.equal(db.reducerCalls.length, 0);
    const result = await runGenerateCreatives(TASK_ID, { spacetime: db, client: client(), log: quiet, takeover: true });
    assert.equal(result.ranked, 3);
    assert.equal(db.tables.task.find((task) => task.task_id === TASK_ID)?.status, 'done');
  });

  it('queues no run_round past the run’s rounds_planned, or when told to skip it', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const last = board([taskRow({ payload: JSON.stringify(payload(1)) })], 1);
    const result = await runGenerateCreatives(TASK_ID, { spacetime: last, client: client(), log: quiet });
    assert.equal(result.round_created, 2);
    assert.equal(result.next_task, null);
    assert.ok(!reducers(last).includes('enqueue_task'));

    const held = board();
    const skipped = await runGenerateCreatives(TASK_ID, { spacetime: held, client: client(), log: quiet, nextRound: 'skip' });
    assert.equal(skipped.next_task, null);
    assert.ok(!reducers(held).includes('enqueue_task'));
  });

  it('returns the winner’s result when another caller completed the task first', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const db = board();
    const theirs = { round_created: 1, written: 3, next_task: 'theirs' };
    const call = db.call.bind(db);
    db.call = async (reducer, args) => {
      if (reducer === 'complete_task') {
        Object.assign(db.tables.task.find((task) => task.task_id === TASK_ID)!, { status: 'done', result: JSON.stringify(theirs) });
        throw new SpacetimeError(`complete_task: HTTP 530: task ${TASK_ID} is done, not claimed`, 530);
      }
      return call(reducer, args);
    };
    assert.deepEqual(await runGenerateCreatives(TASK_ID, { spacetime: db, client: client(), log: quiet }), theirs);
  });

  it('writes what a feed shows before “… more”, so a long ad still fits the sim’s 450-word state', async () => {
    const long = Array.from({ length: 90 }, () => 'oats').join(' ');
    const chat = mockChat(() => ({ ...CLEAN_COPY, primaryText: long }));
    restore = chat.restore;
    const db = board();
    const result = await runGenerateCreatives(TASK_ID, { spacetime: db, client: client(), log: quiet });
    assert.equal(result.ranked, 3);
    const rows = db.tables.creative.filter((creative) => creative.origin === 'generated');
    assert.ok(rows.every((row) => String(row.primary_text).split(' ').length === 25 && String(row.primary_text).endsWith('…')));
  });
});

describe('failTask', () => {
  it('fails only a task the caller still holds', async () => {
    const db = board([taskRow({ status: 'done', claimed_by: 'creative_worker', result: '{}' })]);
    assert.equal(await failTask(db, TASK_ID, new Error('late')), false);
    assert.equal(db.tables.task[0].status, 'done');
    const held = board([taskRow({ status: 'claimed', claimed_by: 'copywriter' })]);
    assert.equal(await failTask(held, TASK_ID, new Error('boom')), false);
    assert.equal(await failTask(held, TASK_ID, new Error('boom'), 'copywriter'), true);
    assert.equal(held.tables.task[0].status, 'failed');
  });
});

describe('runCreativeTaskLoop', () => {
  it('claims a task once it has sat unclaimed for a minute, and leaves younger ones for the Copywriter', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const young = taskRow({ task_id: `tsk_gen_${RUN_ID}_r9`, created_at: new Date().toISOString() });
    const db = board([taskRow(), young]);
    const stop = new AbortController();
    await runCreativeTaskLoop({
      signal: stop.signal,
      spacetime: db,
      client: client(),
      pollMs: 5,
      log: (line) => {
        if (line.startsWith('done:')) stop.abort();
      },
    });
    const status = Object.fromEntries(db.tables.task.map((task) => [task.task_id, task.status]));
    assert.equal(status[TASK_ID], 'done');
    assert.equal(status[`tsk_gen_${RUN_ID}_r9`], 'queued');
    assert.equal(db.tables.task.find((task) => task.task_id === TASK_ID)?.claimed_by, 'creative_worker');
  });

  it('takes over a claim left untouched for 15 minutes, but not a fresh one', async () => {
    const chat = mockChat(() => CLEAN_COPY);
    restore = chat.restore;
    const fresh = taskRow({ task_id: `tsk_gen_${RUN_ID}_r9`, status: 'claimed', claimed_by: 'copywriter', updated_at: new Date().toISOString() });
    const db = board([taskRow({ status: 'claimed', claimed_by: 'copywriter' }), fresh]);
    const stop = new AbortController();
    await runCreativeTaskLoop({
      signal: stop.signal,
      spacetime: db,
      client: client(),
      pollMs: 5,
      log: (line) => {
        if (line.startsWith('done:')) stop.abort();
      },
    });
    const status = Object.fromEntries(db.tables.task.map((task) => [task.task_id, task.status]));
    assert.equal(status[TASK_ID], 'done');
    assert.equal(status[`tsk_gen_${RUN_ID}_r9`], 'claimed');
  });
});

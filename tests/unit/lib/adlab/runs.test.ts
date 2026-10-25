import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RunRefusedError, startRun, type StartRunInput } from '@/lib/adlab/runs';
import { resolveSpacetimeTarget, type SqlRow } from '@/lib/adlab/spacetime-http';
import { DEMO_DATABASE, benchTarget } from '@/lib/adlab/targets';
import type { RoundZeroStatus } from '@/worker/creatives/run';
import { FakeStdb } from '../../worker/creatives/helpers';

const COMPLETE: RoundZeroStatus = { complete: true, problems: [], expected: 54, ranked: [], gatedOut: [], missing: [], recipesWithoutRanked: [] };
const INCOMPLETE: RoundZeroStatus = { ...COMPLETE, complete: false, problems: ['3 round-0 creative(s) not written'] };
const input: StartRunInput = { runId: 'run_t1', roundsPlanned: 2, requestedBy: 'agt_strategist' };

function bench(tables: Record<string, SqlRow[]> = {}, target = benchTarget('local')) {
  return new FakeStdb({ run: [], task: [], ...tables }, { target });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof RunRefusedError, String(err));
    return err.code;
  }
  assert.fail('expected a refusal');
}

describe('startRun', () => {
  it('pre-creates the run row with its settings, then queues round 0, and nothing else', async () => {
    const db = bench();
    const result = await startRun(db, input, { roundZero: async () => COMPLETE });
    assert.deepEqual(result, { run_id: 'run_t1', task_id: 'tsk_run_run_t1_r0', rounds_planned: 2, population: 300, seed: 13, requeued: false });
    assert.deepEqual(db.reducerCalls.map((call) => call.reducer), ['upsert_run', 'enqueue_task']);
    const run = JSON.parse(db.reducerCalls[0].args[0] as string);
    assert.deepEqual(run, {
      run_id: 'run_t1',
      seed: 13,
      population: 300,
      rounds_planned: 2,
      ticks_per_round: 3,
      status: 'calibrating',
      calibration: '{}',
      jev_model: 'jev-1.13.0',
      config_hash: 'pending',
    });
    assert.deepEqual(db.reducerCalls[1].args, ['tsk_run_run_t1_r0', 'run_round', JSON.stringify({ run_id: 'run_t1', round: 0 })]);
  });

  it("refuses B's demo database and any target it can't see", async () => {
    const demo = bench({}, resolveSpacetimeTarget({ uri: 'https://maincloud.spacetimedb.com', dbName: DEMO_DATABASE }));
    assert.equal(await refusal(startRun(demo, input, { roundZero: async () => COMPLETE })), 'runs_not_allowed');
    assert.equal(demo.reducerCalls.length, 0);
    const blind = new FakeStdb({ run: [], task: [] });
    assert.equal(await refusal(startRun(blind, input, { roundZero: async () => COMPLETE })), 'runs_not_allowed');
  });

  it('validates the run id and the settings', async () => {
    for (const bad of [{ runId: 'Run-1' }, { runId: 'run_' }, { roundsPlanned: 6 }, { roundsPlanned: 0 }, { population: 20 }, { population: 301 }, { seed: -1 }]) {
      assert.equal(await refusal(startRun(bench(), { ...input, ...bad }, { roundZero: async () => COMPLETE })), 'bad_request', JSON.stringify(bad));
    }
  });

  it('refuses a second run in the same database, and an id already used', async () => {
    const other = bench({ run: [{ run_id: 'run_other', status: 'done', config_hash: 'abc' }] });
    assert.equal(await refusal(startRun(other, input, { roundZero: async () => COMPLETE })), 'db_has_run');
    const queued = bench({ task: [{ task_id: 'tsk_run_run_q_r0', run_id: 'run_q', kind: 'run_round', status: 'queued' }] });
    assert.equal(await refusal(startRun(queued, input, { roundZero: async () => COMPLETE })), 'db_has_run');
    const same = bench({ run: [{ run_id: 'run_t1', status: 'running', config_hash: 'abc' }] });
    assert.equal(await refusal(startRun(same, input, { roundZero: async () => COMPLETE })), 'run_exists');
  });

  it('starts beside another run only when asked to, and only locally', async () => {
    const other = bench({ run: [{ run_id: 'run_other', status: 'done', config_hash: 'abc' }] });
    const result = await startRun(other, { ...input, allowOtherRuns: true }, { roundZero: async () => COMPLETE });
    assert.equal(result.task_id, 'tsk_run_run_t1_r0');
    const live = bench({ run: [{ run_id: 'run_other', status: 'done', config_hash: 'abc' }] }, benchTarget('live'));
    assert.equal(await refusal(startRun(live, { ...input, allowOtherRuns: true }, { roundZero: async () => COMPLETE })), 'db_has_run');
  });

  it("re-queues round 0 for its own leftover placeholder row instead of refusing", async () => {
    const db = bench({ run: [{ run_id: 'run_t1', status: 'calibrating', config_hash: 'pending' }] });
    const result = await startRun(db, input, { roundZero: async () => COMPLETE });
    assert.equal(result.requeued, true);
    assert.deepEqual(db.reducerCalls.map((call) => call.reducer), ['upsert_run', 'enqueue_task']);
  });

  it('refuses until round 0 is complete, writing nothing', async () => {
    const db = bench();
    assert.equal(await refusal(startRun(db, input, { roundZero: async () => INCOMPLETE })), 'round0_incomplete');
    assert.equal(db.reducerCalls.length, 0);
  });
});

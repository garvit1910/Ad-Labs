import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AgentRuleError,
  boundedPayload,
  clampLine,
  logAgentMessage,
  newMessageId,
  readLearnings,
  readTasks,
  reportIngestJob,
  setAgentStatus,
  upsertIngestJob,
} from '@/lib/adlab/agent-api';
import { codePoints, MESSAGE_ID_RE, messageIdProblem, utf8Bytes } from '@/spacetime/src/agent_rules';
import { FakeStdb } from '../../worker/creatives/helpers';

const message = {
  from_agent: 'agt_ad_lab',
  to_agent: 'agt_scout',
  protocol: 'AdLabIntel',
  kind: 'request',
  summary: 'Refresh the two stalest pages',
  payload: { pages: 2 },
};

const status = { agent_id: 'agt_scout', name: 'Ad Lab Scout', role: 'Intel', address: '', status: 'working', current_step: 'Picking pages' };

describe('newMessageId', () => {
  it('is msg_<base36 ms>_<8 hex>, passes the module rule, and never repeats', () => {
    const id = newMessageId(1_761_350_400_000);
    assert.match(id, /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
    assert.ok(id.startsWith(`msg_${(1_761_350_400_000).toString(36)}_`));
    assert.equal(messageIdProblem(id), null);
    const ids = new Set(Array.from({ length: 1000 }, () => newMessageId()));
    assert.equal(ids.size, 1000);
    for (const each of ids) assert.match(each, MESSAGE_ID_RE);
  });
});

describe('clamps', () => {
  it('clampLine makes one line of at most max code points, ending in … when cut', () => {
    assert.equal(clampLine('  two\nlines\t here ', 140), 'two lines here');
    const long = clampLine('x'.repeat(300), 140);
    assert.equal(codePoints(long), 140);
    assert.ok(long.endsWith('…'));
    const emoji = clampLine('😀'.repeat(200), 140);
    assert.equal(codePoints(emoji), 140);
    assert.equal(clampLine('a'.repeat(140), 140), 'a'.repeat(140));
  });

  it('boundedPayload keeps a small payload and stubs a large one as {truncated, bytes, keys}', () => {
    assert.equal(boundedPayload({ a: 1 }), '{"a":1}');
    const big = { notes: 'x'.repeat(10_000), round: 2 };
    const stub = JSON.parse(boundedPayload(big));
    assert.deepEqual(stub, { truncated: true, bytes: utf8Bytes(JSON.stringify(big)), keys: ['notes', 'round'] });
    const manyKeys = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}_${'y'.repeat(60)}`, 'z'.repeat(40)]));
    const capped = boundedPayload(manyKeys);
    assert.ok(utf8Bytes(capped) <= 4096);
    assert.equal(JSON.parse(capped).truncated, true);
  });
});

describe('writers', () => {
  it('logAgentMessage clamps, then calls log_agent_message with positional args in the module order', async () => {
    const db = new FakeStdb({});
    const id = await logAgentMessage(db, { ...message, summary: 's'.repeat(300), payload: { blob: 'x'.repeat(10_000) }, run_id: 'run_local_1' });
    assert.equal(db.reducerCalls.length, 1);
    const { reducer, args } = db.reducerCalls[0];
    assert.equal(reducer, 'log_agent_message');
    assert.equal(args.length, 8);
    const [messageId, runId, from, to, protocol, kind, summary, payload] = args as string[];
    assert.deepEqual([messageId, runId, from, to, protocol, kind], [id, 'run_local_1', 'agt_ad_lab', 'agt_scout', 'AdLabIntel', 'request']);
    assert.equal(codePoints(summary), 140);
    assert.ok(summary.endsWith('…'));
    assert.equal(JSON.parse(payload).truncated, true);
    assert.equal(db.tables.agent_message.length, 1);
    assert.equal(db.tables.agent_message[0].run_id, 'run_local_1');
  });

  it('defaults run_id to "" and rejects a bad message before any call', async () => {
    const db = new FakeStdb({});
    await logAgentMessage(db, message);
    assert.equal(db.reducerCalls[0].args[1], '');
    await assert.rejects(logAgentMessage(db, { ...message, to_agent: 'agt_ad_lab' }), AgentRuleError);
    await assert.rejects(logAgentMessage(db, { ...message, kind: 'event' }), /kind "event"/);
    await assert.rejects(logAgentMessage(db, { ...message, from_agent: 'scout' }), /from_agent/);
    assert.equal(db.reducerCalls.length, 1);
  });

  it('the module rejects a repeated message id', async () => {
    const db = new FakeStdb({});
    const args = ['msg_dup_1', '', 'user', 'agt_ad_lab', 'AgentChatProtocol', 'request', 'hi', '{}'];
    await db.call('log_agent_message', args);
    await assert.rejects(db.call('log_agent_message', args), /already logged/);
  });

  it('setAgentStatus clamps current_step and calls upsert_agent in the module order', async () => {
    const db = new FakeStdb({});
    await setAgentStatus(db, { ...status, current_step: 'step\none '.repeat(40) });
    const { reducer, args } = db.reducerCalls[0];
    assert.equal(reducer, 'upsert_agent');
    assert.deepEqual(args.slice(0, 5), ['agt_scout', 'Ad Lab Scout', 'Intel', '', 'working']);
    assert.ok(codePoints(String(args[5])) <= 140 && !String(args[5]).includes('\n'));
    await setAgentStatus(db, { ...status, status: 'idle', current_step: '' });
    assert.equal(db.tables.agent.length, 1);
    assert.equal(db.tables.agent[0].status, 'idle');
    await assert.rejects(setAgentStatus(db, { ...status, status: 'busy' }), /status "busy" is not one of idle, working, error/);
    assert.equal(db.reducerCalls.length, 2);
  });

  it('ingest writers call the module in order; a report never un-finishes a job', async () => {
    const db = new FakeStdb({});
    const job = {
      job_id: '3f1c2b9a-7d4e-4c1a-9b2f-0e6d5c4b3a21',
      requested_by: 'agt_scout',
      job_type: 'adlib_sync_competitor',
      target: 'Catalina Crunch · Meta ads',
      actor: 'curious_coder/facebook-ads-library-scraper',
      status: 'pending',
      items: 0,
      error: '',
    };
    await upsertIngestJob(db, job);
    assert.deepEqual(db.reducerCalls[0], { reducer: 'upsert_ingest_job', args: Object.values(job) });
    await reportIngestJob(db, { job_id: job.job_id, status: 'completed', items: 7, error: '' });
    await reportIngestJob(db, { job_id: job.job_id, status: 'processing', items: 0, error: '' });
    await reportIngestJob(db, { job_id: '00000000-0000-4000-8000-000000000000', status: 'completed', items: 1, error: '' });
    assert.equal(db.tables.ingest_job.length, 1);
    assert.equal(db.tables.ingest_job[0].status, 'completed');
    assert.equal(db.tables.ingest_job[0].items, 7);
    await assert.rejects(upsertIngestJob(db, { ...job, requested_by: 'scout' }), /requested_by/);
  });
});

describe('readers', () => {
  const task = (id: string, run: string, kind: string, statusName: string, created: string, result: string | null = null) => ({
    task_id: id,
    run_id: run,
    kind,
    payload: JSON.stringify({ run_id: run, round: 0 }),
    status: statusName,
    claimed_by: statusName === 'queued' ? null : 'sim_worker',
    result,
    created_at: created,
    updated_at: created,
  });

  it('readTasks filters on every given field, parses payload and result, oldest first', async () => {
    const db = new FakeStdb({
      task: [
        task('tsk_run_run_a_r1', 'run_a', 'run_round', 'queued', '2026-10-25T07:02:00.000Z'),
        task('tsk_run_run_a_r0', 'run_a', 'run_round', 'done', '2026-10-25T07:00:00.000Z', '{"impressions":10}'),
        task('tsk_gen_run_a_r0', 'run_a', 'generate_creatives', 'done', '2026-10-25T07:01:00.000Z', 'not json'),
        task('tsk_run_run_b_r0', 'run_b', 'run_round', 'queued', '2026-10-25T06:00:00.000Z'),
      ],
    });
    const all = await readTasks(db, { run_id: 'run_a' });
    assert.deepEqual(all.map((t) => t.task_id), ['tsk_run_run_a_r0', 'tsk_gen_run_a_r0', 'tsk_run_run_a_r1']);
    assert.deepEqual(all[0].payload, { run_id: 'run_a', round: 0 });
    assert.deepEqual(all[0].result, { impressions: 10 });
    assert.equal(all[1].result, null);
    assert.equal(all[2].claimed_by, null);
    const done = await readTasks(db, { run_id: 'run_a', kind: 'run_round', status: 'done' });
    assert.deepEqual(done.map((t) => t.task_id), ['tsk_run_run_a_r0']);
    assert.equal((await readTasks(db, { task_id: 'tsk_run_run_b_r0' })).length, 1);
  });

  it('readLearnings joins segment names and keeps only the asked ids', async () => {
    const learning = (id: string, round: number, arm: string | null) => ({
      learning_id: id,
      run_id: 'run_a',
      segment_id: 'seg_keto',
      arm_id: arm,
      kind: 'objection',
      statement: 's',
      directive: 'd',
      evidence: '{}',
      source: 'simulated',
      valid_from_round: round,
      valid_to_round: null,
    });
    const db = new FakeStdb({
      segment: [{ segment_id: 'seg_keto', name: 'Keto low-carb', share: 0.3 }],
      learning: [learning('lrn_b', 1, 'arm_02'), learning('lrn_a', 0, null), { ...learning('lrn_other', 0, null), run_id: 'run_b' }],
    });
    const rows = await readLearnings(db, { run_id: 'run_a' });
    assert.deepEqual(rows.map((r) => r.learning_id), ['lrn_a', 'lrn_b']);
    assert.equal(rows[0].segment_name, 'Keto low-carb');
    assert.equal(rows[0].arm_id, null);
    assert.equal(rows[1].arm_id, 'arm_02');
    assert.deepEqual((await readLearnings(db, { run_id: 'run_a', ids: ['lrn_b'] })).map((r) => r.learning_id), ['lrn_b']);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_ORDER,
  USER_NAME,
  ago,
  agentCards,
  jobRows,
  latestRunId,
  messageStream,
  partyName,
  prettyPayload,
  runIds,
  shortAddress,
  taskColumns,
} from '@/app/agents/_lib/selectors';

const ts = (ms: number) => ({ microsSinceUnixEpoch: BigInt(ms) * BigInt(1000) });
const NOW = 1_800_000_000_000;

const agent = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  name: 'Scout',
  role: 'Refreshes data',
  address: 'agent1qxyzxyzxyzxyzxyzxyz1234',
  status: 'working',
  currentStep: 'Picking stale pages',
  updatedAt: ts(NOW - 12_000),
  ...over,
});

const msg = (messageId: string, at: number, over: Record<string, unknown> = {}) => ({
  messageId,
  runId: '',
  fromAgent: 'agt_ad_lab',
  toAgent: 'agt_scout',
  protocol: 'adlab/refresh/v1',
  kind: 'request',
  summary: 'refresh the stalest pages',
  payload: '{"pages":2}',
  createdAt: ts(at),
  ...over,
});

const task = (taskId: string, status: string, runId: string, updated: number, over: Record<string, unknown> = {}) => ({
  taskId,
  runId,
  kind: 'run_round',
  payload: '{}',
  status,
  claimedBy: undefined as string | undefined,
  result: undefined as string | undefined,
  createdAt: ts(updated - 1000),
  updatedAt: ts(updated),
  ...over,
});

describe('agentCards', () => {
  it('shows the four agents in order, placeholders until their rows exist', () => {
    const cards = agentCards([agent('agt_scout')], [msg('m1', NOW), msg('m2', NOW, { fromAgent: 'agt_scout', toAgent: 'agt_ad_lab' })], NOW);
    assert.deepEqual(
      cards.map((c) => c.agentId),
      [...AGENT_ORDER],
    );
    const [adLab, scout] = cards;
    assert.equal(adLab!.placeholder, true);
    assert.equal(adLab!.name, 'Ad Lab');
    assert.equal(adLab!.tone, 'not_set');
    assert.equal(adLab!.updatedAgo, 'never');
    assert.equal(scout!.placeholder, false);
    assert.equal(scout!.tone, 'active');
    assert.equal(scout!.currentStep, 'Picking stale pages');
    assert.equal(scout!.updatedAgo, '12s ago');
    assert.equal(scout!.sent, 1);
    assert.equal(scout!.received, 1);
  });

  it('maps statuses to tones and appends unknown agents', () => {
    const cards = agentCards([agent('agt_ad_lab', { status: 'idle' }), agent('agt_copywriter', { status: 'error' }), agent('agt_zzz')], [], NOW);
    assert.equal(cards[0]!.tone, 'connected');
    assert.equal(cards[3]!.tone, 'failed');
    assert.equal(cards[4]!.agentId, 'agt_zzz');
  });
});

describe('messageStream', () => {
  const messages = [
    msg('m1', NOW - 3000),
    msg('m3', NOW - 1000, { runId: 'run_t1', fromAgent: 'agt_strategist', toAgent: 'agt_copywriter' }),
    msg('m2', NOW - 2000, { fromAgent: 'user', toAgent: 'agt_ad_lab' }),
  ];
  it('is newest first with readable party names', () => {
    const rows = messageStream(messages);
    assert.deepEqual(
      rows.map((r) => r.messageId),
      ['m3', 'm2', 'm1'],
    );
    assert.equal(rows[1]!.fromName, USER_NAME);
    assert.equal(rows[0]!.toName, 'Copywriter');
  });
  it('filters by run and by agent (sender or receiver), and limits', () => {
    assert.deepEqual(
      messageStream(messages, { runId: 'run_t1' }).map((r) => r.messageId),
      ['m3'],
    );
    assert.deepEqual(
      messageStream(messages, { runId: '' }).map((r) => r.messageId),
      ['m2', 'm1'],
    );
    assert.deepEqual(
      messageStream(messages, { agentId: 'agt_ad_lab' }).map((r) => r.messageId),
      ['m2', 'm1'],
    );
    assert.equal(messageStream(messages, { limit: 1 }).length, 1);
  });
});

describe('jobRows', () => {
  it('is newest update first, with tones and dry runs marked', () => {
    const job = (jobId: string, status: string, updated: number, error = '') => ({
      jobId,
      requestedBy: 'agt_scout',
      jobType: 'adlib_sync_competitor',
      target: 'GHOST · Meta ads',
      actor: 'curious_coder~facebook-ads-library-scraper',
      status,
      items: 0,
      error,
      createdAt: ts(updated - 5000),
      updatedAt: ts(updated),
    });
    const rows = jobRows([job('a', 'completed', NOW - 5000), job('b', 'skipped', NOW, 'dry run (test mode)'), job('c', 'pending', NOW - 1000)]);
    assert.deepEqual(
      rows.map((r) => [r.jobId, r.tone, r.dry]),
      [
        ['b', 'not_set', true],
        ['c', 'queued', false],
        ['a', 'connected', false],
      ],
    );
    assert.equal(rows[0]!.requestedByName, 'Scout');
  });
});

describe('taskColumns and runs', () => {
  const tasks = [
    task('tsk_run_run_a_r0', 'done', 'run_a', NOW - 5000),
    task('tsk_gen_run_a_r0', 'claimed', 'run_a', NOW - 1000, { kind: 'generate_creatives', claimedBy: 'copywriter' }),
    task('tsk_run_run_a_r1', 'queued', 'run_a', NOW),
    task('tsk_run_run_b_r0', 'failed', 'run_b', NOW, { result: 'boom' }),
    task('tsk_run_run_a_r9', 'weird', 'run_a', NOW),
  ];
  it('groups one run by status, newest first, ignoring unknown statuses', () => {
    const cols = taskColumns(tasks, 'run_a');
    assert.deepEqual(
      Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.map((t) => t.taskId)])),
      { queued: ['tsk_run_run_a_r1'], claimed: ['tsk_gen_run_a_r0'], done: ['tsk_run_run_a_r0'], failed: [] },
    );
    assert.equal(taskColumns(tasks, null).failed.length, 1);
  });
  it('picks the newest run across run rows and runs known only from tasks', () => {
    const runs = [
      { runId: 'run_old', createdAt: ts(NOW - 100_000) },
      { runId: 'run_a', createdAt: ts(NOW - 50_000) },
    ];
    assert.equal(latestRunId(runs, tasks), 'run_b');
    assert.deepEqual(runIds(runs, []), ['run_a', 'run_old']);
    assert.equal(latestRunId([], []), null);
  });
});

describe('small formats', () => {
  it('ago, partyName, shortAddress, prettyPayload', () => {
    assert.equal(ago(NOW, NOW), 'just now');
    assert.equal(ago(NOW - 90_000, NOW), '1m ago');
    assert.equal(ago(NOW - 2 * 3_600_000, NOW), '2h ago');
    assert.equal(partyName('user'), USER_NAME);
    assert.equal(partyName('agt_strategist'), 'Strategist');
    assert.equal(partyName('agt_scout', [agent('agt_scout', { name: 'Scout v2' })]), 'Scout v2');
    assert.equal(shortAddress('agent1qxyzxyzxyzxyzxyzxyz1234'), 'agent1qxyzx…1234');
    assert.equal(shortAddress(''), '');
    assert.equal(prettyPayload('{"a":1}'), '{\n  "a": 1\n}');
    assert.equal(prettyPayload('not json'), 'not json');
  });
});

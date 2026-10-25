import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextReplayId, replayProgress, replaySource } from '@/app/sim/_lib/replay';

describe('nextReplayId', () => {
  it('names a replay the way sim:replay does', () => {
    assert.equal(nextReplayId('run_a', ['run_a']), 'run_a_replay');
    assert.equal(nextReplayId('run_a', ['run_a', 'run_a_replay']), 'run_a_replay_2');
    assert.equal(nextReplayId('run_a', ['run_a', 'run_a_replay', 'run_a_replay_2']), 'run_a_replay_3');
  });
});

describe('replaySource', () => {
  const runs = [
    { runId: 'run_a', status: 'done' },
    { runId: 'run_a_replay_2', status: 'stopped' },
    { runId: 'run_b', status: 'running' },
    { runId: 'run_b_replay', status: 'failed' },
  ];
  it('replays a finished run itself', () => {
    assert.equal(replaySource('run_a', 'done', runs), 'run_a');
  });
  it('replays the source of a stopped or failed replay when that source is finished', () => {
    assert.equal(replaySource('run_a_replay_2', 'stopped', runs), 'run_a');
    assert.equal(replaySource('run_b_replay', 'failed', runs), null);
  });
  it('has nothing to replay for an unfinished run', () => {
    assert.equal(replaySource('run_b', 'running', runs), null);
    assert.equal(replaySource(null, null, runs), null);
  });
});

describe('replayProgress', () => {
  it('counts finished rounds from sim:replay output and keeps its verdict', () => {
    const lines = [
      'sim replay sim-replay:abc → http://127.0.0.1:3100 / adlab-local (LOCAL)',
      'replaying run_a as run_a_replay: 4 rounds, 3000 ms per sim day, Jev from cache only',
      '  round 0: 721 impressions, 1 buys',
      '  round 1: 720 impressions, 0 buys',
    ];
    assert.deepEqual(replayProgress(lines), { roundsDone: 2, roundsTotal: 4, outcome: null });
    const done = [...lines, '  round 2: 718 impressions, 0 buys', '  round 3: 719 impressions, 1 buys', 'identical to run_a: 5,760 decisions, 4 round summaries (40 s, no Jev calls)'];
    assert.deepEqual(replayProgress(done), {
      roundsDone: 4,
      roundsTotal: 4,
      outcome: 'identical to run_a: 5,760 decisions, 4 round summaries (40 s, no Jev calls)',
    });
  });

  it('reports why a replay stopped', () => {
    const { outcome } = replayProgress(['Error: run run_a is running; replay a finished run']);
    assert.match(outcome ?? '', /replay a finished run/);
  });
});

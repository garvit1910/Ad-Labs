import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPEN_CHAT, chatSessions, chatText, chatThread, replayDelays, roomName, sessionIds, tidy } from '@/app/agents/_lib/chat';

const ts = (ms: number) => ({ microsSinceUnixEpoch: BigInt(ms) * BigInt(1000) });
const T0 = 1_800_000_000_000;
const RUN = 'run_test_1025_0903';

const msg = (messageId: string, at: number, over: Record<string, unknown> = {}) => ({
  messageId,
  runId: '',
  fromAgent: 'agt_ad_lab',
  toAgent: 'agt_scout',
  protocol: 'adlab/intel/v1',
  kind: 'request',
  summary: 'hello',
  payload: '{}',
  createdAt: ts(at),
  ...over,
});

describe('sessionIds and chatSessions', () => {
  const messages = [
    msg('m1', T0, { fromAgent: 'user', toAgent: 'agt_ad_lab', summary: '@agent1qdefj find ads' }),
    msg('m2', T0 + 1000, { summary: 'Intel request: find ads' }),
    msg('m3', T0 + 60_000, { runId: RUN, fromAgent: 'agt_strategist', toAgent: 'agt_ad_lab', summary: `Plan plan_6edb7b36: 11 recipes + control, 3 rounds, ${RUN}` }),
    msg('m4', T0 + 120_000, { runId: RUN, fromAgent: 'agt_strategist', toAgent: 'agt_ad_lab', summary: 'Round 3 of 3 is running: 300 shoppers, 3 sim days.' }),
    msg('m5', T0 - 3_600_000, { summary: 'an old hello' }),
  ];

  it('puts run-less messages in the next run starting soon after, else in open chat', () => {
    const ids = sessionIds(messages, []);
    assert.equal(ids.get('m1'), RUN);
    assert.equal(ids.get('m2'), RUN);
    assert.equal(ids.get('m3'), RUN);
    assert.equal(ids.get('m5'), OPEN_CHAT);
  });

  it('uses run rows for start times too', () => {
    const ids = sessionIds([msg('a', T0)], [{ runId: 'run_x', createdAt: ts(T0 + 5000) }]);
    assert.equal(ids.get('a'), 'run_x');
  });

  it('lists sessions newest activity first with a readable preview', () => {
    const sessions = chatSessions(messages, sessionIds(messages, []));
    assert.deepEqual(
      sessions.map((s) => [s.id, s.count]),
      [
        [RUN, 4],
        [OPEN_CHAT, 1],
      ],
    );
    assert.equal(sessions[0].runId, RUN);
    assert.match(sessions[0].label, /^Run · /);
    assert.equal(sessions[0].preview, 'Strategist: Round 3 of 3 is running: 300 shoppers, 3 sim days.');
    assert.equal(sessions[1].label, 'Open chat');
  });
});

describe('chatThread', () => {
  it('is oldest first, merges broadcasts and folds Ad Lab relays into the original', () => {
    const done = `Run ${RUN} done: 1 winners, 4 leaders`;
    const ping = 'Round 3 of 3 is running: 300 shoppers, 3 sim days.';
    const rows = [
      msg('c', T0 + 2000, { runId: RUN, fromAgent: 'agt_strategist', toAgent: 'agt_copywriter', kind: 'result', summary: done }),
      msg('b', T0 + 1900, { runId: RUN, fromAgent: 'agt_strategist', toAgent: 'agt_ad_lab', kind: 'result', summary: done }),
      msg('a', T0, { runId: RUN, fromAgent: 'agt_strategist', toAgent: 'agt_ad_lab', kind: 'progress', summary: ping }),
      msg('a2', T0 + 100, { runId: RUN, fromAgent: 'agt_ad_lab', toAgent: 'user', kind: 'progress', summary: ping }),
      msg('d', T0 + 3000, { runId: RUN, fromAgent: 'agt_ad_lab', toAgent: 'user', kind: 'result', summary: 'Card: Winning ads per segment' }),
    ];
    const thread = chatThread(rows, sessionIds(rows, []), RUN);
    assert.deepEqual(
      thread.map((b) => b.id),
      ['a', 'b', 'd'],
    );
    assert.deepEqual(thread[0].forwardedTo, ['You (ASI:One)']);
    assert.deepEqual(thread[1].to, ['agt_ad_lab', 'agt_copywriter']);
    assert.deepEqual(thread[1].toNames, ['Ad Lab', 'Copywriter']);
    assert.equal(thread[1].text, "That's a wrap: 1 winner and 4 leaders.");
    assert.equal(thread[2].card, 'Winning ads per segment');
  });

  it('keeps a reply to the user that no agent said first', () => {
    const rows = [msg('a', T0, { fromAgent: 'agt_ad_lab', toAgent: 'user', kind: 'reply', summary: `Starting ${RUN}: 3 rounds after the warm-up, 300 shoppers.` })];
    const [b] = chatThread(rows, sessionIds(rows, []), OPEN_CHAT);
    assert.equal(b.text, 'Starting the run: 3 rounds after the warm-up, 300 shoppers.');
    assert.deepEqual(b.forwardedTo, []);
  });

  it('is empty without a session', () => {
    assert.deepEqual(chatThread([msg('a', T0)], new Map(), null), []);
  });
});

describe('chatText', () => {
  const cases: [string, string][] = [
    ["Intel request: @agent1qdefjvvn2z find ads that beat Magic Spoon's current ones", `New ask from the user: "find ads that beat Magic Spoon's current ones". Can you pull fresh intel?`],
    ['Plan request: @agent1qdefjvvn2z find ads', 'Intel\'s in. Can you draft test recipes for "find ads"?'],
    [
      'Intel: 3 pains, 6 competitor winners; refresh 2 picked, 2 jobs (test)',
      "Here's the intel: 3 customer pains and 6 competitor ads that are winning. Refreshing 2 stale sources (test mode, so dry runs).",
    ],
    ['Intel: something new', "Here's the intel: something new"],
    [`Plan plan_6edb7b36: 11 recipes + control, 3 rounds, ${RUN}`, "Plan's ready: 11 ad recipes plus a control, tested over 3 rounds."],
    [`Plan plan_1: 1 recipes + control, 1 rounds, ${RUN} (blocked: no slot)`, "Plan's ready: 1 ad recipe plus a control, tested over 1 round. Blocked for now: no slot."],
    [`User approved plan_6edb7b36: start ${RUN} (3 rounds)`, 'The user approved the plan. Kick off all 3 rounds.'],
    [`Queued tsk_run_${RUN}_r0 on adlab-local (3 rounds)`, 'On it. The warm-up round is queued, 3 rounds to follow.'],
    [`Run ${RUN} started: watch its creative tasks`, "We're live. Watch the task board and write fresh ads after every round."],
    [`Run ${RUN} not started: no free slot`, "Couldn't start the run: no free slot"],
    [`Round 0 creatives: 4 written, 4 ranked; next tsk_run_${RUN}_r1`, 'Round 0 ads are in: 4 written and ranked. Next round is queued.'],
    ['Status: round 2 of 3 running', 'round 2 of 3 running'],
    ['@agent1qdefjvvn2z {"action":"start_run","plan_id":"plan_6edb7b36","approved":true}', 'Looks good, approved. Start the run!'],
    [`Copywriter wrote 4 ads (4 ranked) and queued tsk_run_${RUN}_r1.`, 'Copywriter wrote 4 ads (4 ranked) and queued round 1.'],
    [
      `Strategist queued round 0 of ${RUN} on the task board (adlab-local). B's sim worker picks it up next.`,
      'Strategist queued round 0 of the run on the task board. The simulator picks it up next.',
    ],
  ];
  for (const [summary, text] of cases) {
    it(summary.slice(0, 40), () => assert.deepEqual(chatText(summary), { text, card: null }));
  }

  it('turns card announcements into cards', () => {
    assert.deepEqual(chatText('Card: Round 3 of 3: leaderboard'), { text: '', card: 'Round 3 of 3: leaderboard' });
    assert.deepEqual(chatText('Card again: Winning ads per segment'), { text: '', card: 'Winning ads per segment' });
  });

  it('tidy leaves plain text alone and reads agent steps naturally', () => {
    assert.equal(tidy('waiting for requests'), 'waiting for requests');
    assert.equal(tidy(`run ${RUN} done`), 'Run finished');
    assert.equal(tidy(`${RUN} done`), 'Run finished');
    assert.equal(tidy(`watching ${RUN}`), 'watching the run');
    assert.equal(tidy('plan plan_6edb7b36 ready'), 'the plan ready');
  });

  it('roomName drops the "Ad Lab " prefix except for Ad Lab itself', () => {
    const rows = ['agt_ad_lab', 'agt_strategist'].map((agentId) => ({
      agentId,
      name: agentId === 'agt_ad_lab' ? 'Ad Lab' : 'Ad Lab Strategist',
      role: '',
      address: '',
      status: 'idle',
      currentStep: '',
      updatedAt: ts(T0),
    }));
    assert.equal(roomName('agt_strategist', rows), 'Strategist');
    assert.equal(roomName('agt_ad_lab', rows), 'Ad Lab');
    assert.equal(roomName('user', rows), 'You (ASI:One)');
  });
});

describe('replayDelays', () => {
  it('uses the real gaps, clamped to 0.5–2.5s, divided by speed', () => {
    const at = [0, 100, 1200, 60_000].map((d) => ({ createdMs: T0 + d }));
    assert.deepEqual(replayDelays(at), [800, 500, 1100, 2500]);
    assert.deepEqual(replayDelays(at, 2), [400, 250, 550, 1250]);
  });
});

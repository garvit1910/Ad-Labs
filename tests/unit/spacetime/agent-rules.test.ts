import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AgentInput,
  type BrandKitInput,
  type IngestJobInput,
  type IngestReportInput,
  type MessageInput,
  addressProblem,
  agentProblem,
  brandKitProblem,
  codePoints,
  currentStepProblem,
  ingestJobProblem,
  ingestReportProblem,
  isAgentId,
  isAgentStatus,
  isIngestStatus,
  isIngestTerminal,
  isMessageKind,
  isParty,
  messageIdProblem,
  messageProblem,
  payloadProblem,
  runIdProblem,
  summaryProblem,
  utf8Bytes,
} from '../../../spacetime/src/agent_rules';

// The pure rules behind upsert_agent, log_agent_message, upsert_ingest_job, report_ingest_job and upsert_brand_kit
// (spacetime/src/agent_rules.ts). The reducers and the agent API both use them.

const agent: AgentInput = {
  agent_id: 'agt_scout',
  name: 'Ad Lab Scout',
  role: 'Refreshes competitor data',
  address: 'agent1qtestaddress0123456789',
  status: 'working',
  current_step: 'Picking stale pages',
};

const message: MessageInput = {
  message_id: 'msg_lx2k9a_1f2e3d4c',
  run_id: 'run_test_1024_2330',
  from_agent: 'agt_ad_lab',
  to_agent: 'agt_scout',
  protocol: 'AdLabIntel',
  kind: 'request',
  summary: 'Refresh the two stalest competitor pages',
  payload: '{"pages":2}',
};

const job: IngestJobInput = {
  job_id: '3f1c2b9a-7d4e-4c1a-9b2f-0e6d5c4b3a21',
  requested_by: 'agt_scout',
  job_type: 'adlib_sync_competitor',
  target: 'Catalina Crunch · Meta ads',
  actor: 'apify/facebook-ads-scraper',
  status: 'pending',
  items: 0,
  error: '',
};

const report: IngestReportInput = { job_id: job.job_id, status: 'completed', items: 12, error: '' };

describe('enums', () => {
  it('agent ids are exactly the four agents', () => {
    for (const id of ['agt_ad_lab', 'agt_scout', 'agt_strategist', 'agt_copywriter']) assert.ok(isAgentId(id), id);
    for (const id of ['user', 'agt_other', 'scout', '']) assert.ok(!isAgentId(id), id);
  });

  it('parties are the agents plus user', () => {
    for (const p of ['agt_ad_lab', 'agt_copywriter', 'user']) assert.ok(isParty(p), p);
    for (const p of ['User', 'copywriter', '']) assert.ok(!isParty(p), p);
  });

  it('statuses and kinds', () => {
    for (const s of ['idle', 'working', 'error']) assert.ok(isAgentStatus(s), s);
    assert.ok(!isAgentStatus('busy'));
    for (const k of ['request', 'reply', 'progress', 'result']) assert.ok(isMessageKind(k), k);
    assert.ok(!isMessageKind('event'));
    for (const s of ['pending', 'processing', 'completed', 'failed', 'skipped']) assert.ok(isIngestStatus(s), s);
    assert.ok(!isIngestStatus('cancelled'));
    for (const s of ['completed', 'failed', 'skipped']) assert.ok(isIngestTerminal(s), s);
    for (const s of ['pending', 'processing']) assert.ok(!isIngestTerminal(s), s);
  });
});

describe('field rules', () => {
  it('counts UTF-8 bytes like Buffer, without TextEncoder', () => {
    for (const s of ['', 'abc', 'é', '·', '€', '😀', 'a😀b€', '\ud800', 'x\udc00y', '\ud83d']) {
      assert.equal(utf8Bytes(s), Buffer.byteLength(s, 'utf8'), JSON.stringify(s));
    }
  });

  it('counts code points, not UTF-16 units', () => {
    assert.equal(codePoints('😀😀'), 2);
    assert.equal(codePoints('abc'), 3);
  });

  it('message_id is msg_ plus lowercase letters, digits and _', () => {
    assert.equal(messageIdProblem('msg_abc_123'), null);
    for (const id of ['', 'msg_', 'msg_ABC', 'msg-abc', 'message_1', 'msg_a b']) assert.ok(messageIdProblem(id), id);
  });

  it('run_id is "" or lowercase letters, digits and _', () => {
    assert.equal(runIdProblem(''), null);
    assert.equal(runIdProblem('run_local_1024'), null);
    for (const id of ['Run_1', 'run-1', ' ']) assert.ok(runIdProblem(id), id);
  });

  it('address is "" or agent1 plus lowercase letters and digits', () => {
    assert.equal(addressProblem(''), null);
    assert.equal(addressProblem('agent1qabc123'), null);
    for (const a of ['agent1', 'agent1Q', 'agent2qabc', 'fetch1qabc', 'agent1q abc']) assert.ok(addressProblem(a), a);
  });

  it('current_step is at most 140 characters and one line', () => {
    assert.equal(currentStepProblem(''), null);
    assert.equal(currentStepProblem('x'.repeat(140)), null);
    assert.equal(currentStepProblem('😀'.repeat(140)), null);
    assert.match(currentStepProblem('x'.repeat(141)) ?? '', /141 characters, more than 140/);
    assert.match(currentStepProblem('step one\nstep two') ?? '', /one line/);
  });

  it('summary is non-empty, at most 140 code points and one line', () => {
    assert.equal(summaryProblem('Refresh done'), null);
    assert.equal(summaryProblem('😀'.repeat(140)), null);
    assert.match(summaryProblem('😀'.repeat(141)) ?? '', /more than 140/);
    assert.match(summaryProblem('   ') ?? '', /empty/);
    assert.match(summaryProblem('a\r\nb') ?? '', /one line/);
  });

  it('payload is a JSON object of at most 4096 bytes', () => {
    assert.equal(payloadProblem('{}'), null);
    assert.equal(payloadProblem('{"a":[1,2]}'), null);
    const fits = `{"s":"${'x'.repeat(4096 - 8)}"}`;
    assert.equal(utf8Bytes(fits), 4096);
    assert.equal(payloadProblem(fits), null);
    assert.match(payloadProblem(`{"s":"${'x'.repeat(4096 - 7)}"}`) ?? '', /4097 bytes, more than 4096/);
    // 2 bytes per é: under 4096 characters but over 4096 bytes.
    assert.match(payloadProblem(`{"s":"${'é'.repeat(2100)}"}`) ?? '', /bytes, more than 4096/);
    assert.match(payloadProblem('not json') ?? '', /not valid JSON/);
    for (const p of ['[]', 'null', '"text"', '3']) assert.match(payloadProblem(p) ?? '', /JSON object/, p);
  });
});

describe('agentProblem', () => {
  it('accepts a valid agent, with or without an address and step', () => {
    assert.equal(agentProblem(agent), null);
    assert.equal(agentProblem({ ...agent, address: '', status: 'idle', current_step: '' }), null);
  });

  it('rejects each bad field, naming it', () => {
    const bad: [Partial<AgentInput>, RegExp][] = [
      [{ agent_id: 'agt_other' }, /agent_id "agt_other" is not one of/],
      [{ agent_id: 'user' }, /agent_id "user"/],
      [{ name: '' }, /name is empty/],
      [{ name: 'n'.repeat(41) }, /name is 41 characters/],
      [{ role: ' ' }, /role is empty/],
      [{ role: 'r'.repeat(81) }, /role is 81 characters/],
      [{ address: 'agent2xyz' }, /address/],
      [{ status: 'busy' }, /status "busy" is not one of idle, working, error/],
      [{ current_step: 's'.repeat(141) }, /current_step/],
      [{ current_step: 'a\nb' }, /current_step must be one line/],
    ];
    for (const [patch, re] of bad) assert.match(agentProblem({ ...agent, ...patch }) ?? '', re, JSON.stringify(patch));
  });
});

describe('messageProblem', () => {
  it('accepts a valid message, including the user and an empty run_id', () => {
    assert.equal(messageProblem(message), null);
    assert.equal(messageProblem({ ...message, from_agent: 'user', to_agent: 'agt_ad_lab', run_id: '', kind: 'reply' }), null);
    assert.equal(messageProblem({ ...message, protocol: 'p'.repeat(80) }), null);
  });

  it('rejects each bad field, naming it', () => {
    const bad: [Partial<MessageInput>, RegExp][] = [
      [{ message_id: 'm_1' }, /message_id/],
      [{ run_id: 'Run 1' }, /run_id/],
      [{ from_agent: 'scout' }, /from_agent "scout" is not one of/],
      [{ to_agent: 'agt_nobody' }, /to_agent "agt_nobody" is not one of/],
      [{ from_agent: 'agt_scout', to_agent: 'agt_scout' }, /from_agent and to_agent are both "agt_scout"/],
      [{ from_agent: 'user', to_agent: 'user' }, /both "user"/],
      [{ protocol: '' }, /protocol is empty/],
      [{ protocol: 'p'.repeat(81) }, /protocol is 81 characters, more than 80/],
      [{ kind: 'event' }, /kind "event" is not one of request, reply, progress, result/],
      [{ summary: '' }, /summary is empty/],
      [{ summary: 's'.repeat(141) }, /summary is 141 characters/],
      [{ summary: 'one\ntwo' }, /summary must be one line/],
      [{ payload: '[1]' }, /payload must be a JSON object/],
      [{ payload: '{' }, /payload is not valid JSON/],
      [{ payload: JSON.stringify({ s: 'x'.repeat(5000) }) }, /payload is \d+ bytes/],
    ];
    for (const [patch, re] of bad) assert.match(messageProblem({ ...message, ...patch }) ?? '', re, JSON.stringify(patch).slice(0, 80));
  });
});

describe('ingestJobProblem', () => {
  it('accepts a valid job, including an empty actor and the user as requester', () => {
    assert.equal(ingestJobProblem(job), null);
    assert.equal(ingestJobProblem({ ...job, actor: '', requested_by: 'user', status: 'skipped', error: 'dry run (test mode)' }), null);
  });

  it('rejects each bad field, naming it', () => {
    const bad: [Partial<IngestJobInput>, RegExp][] = [
      [{ job_id: 'job_1' }, /job_id "job_1" must be a lowercase uuid/],
      [{ job_id: job.job_id.toUpperCase() }, /lowercase uuid/],
      [{ requested_by: 'scout' }, /requested_by "scout" is not one of/],
      [{ job_type: 'Sync' }, /job_type/],
      [{ target: '' }, /target is empty/],
      [{ target: 't'.repeat(121) }, /target is 121 characters/],
      [{ actor: 'a'.repeat(81) }, /actor is 81 characters/],
      [{ status: 'cancelled' }, /status "cancelled" is not one of pending, processing, completed, failed, skipped/],
      [{ items: -1 }, /items -1/],
      [{ items: 1.5 }, /items 1.5/],
      [{ error: 'e'.repeat(1001) }, /error is 1001 characters/],
    ];
    for (const [patch, re] of bad) assert.match(ingestJobProblem({ ...job, ...patch }) ?? '', re, JSON.stringify(patch));
  });
});

describe('ingestReportProblem', () => {
  it('accepts a valid report', () => {
    assert.equal(ingestReportProblem(report), null);
    assert.equal(ingestReportProblem({ ...report, status: 'failed', items: 0, error: 'actor timed out' }), null);
  });

  it('rejects each bad field, naming it', () => {
    const bad: [Partial<IngestReportInput>, RegExp][] = [
      [{ job_id: 'nope' }, /job_id/],
      [{ status: 'done' }, /status "done" is not one of/],
      [{ items: -3 }, /items -3/],
      [{ error: 'e'.repeat(1001) }, /error is 1001 characters/],
    ];
    for (const [patch, re] of bad) assert.match(ingestReportProblem({ ...report, ...patch }) ?? '', re, JSON.stringify(patch));
  });
});

describe('brandKitProblem', () => {
  const sha = 'ab12cd34ef56'.padEnd(64, '0');
  const kit: BrandKitInput = {
    kit_id: 'kit_default',
    brand_url: 'https://magicspoon.com/',
    brand_name: 'Magic Spoon',
    image_file: 'ab12cd34ef56.png',
    image_sha: sha,
  };

  it('accepts a valid kit, including an unmatched brand and a URL with a path', () => {
    assert.equal(brandKitProblem(kit), null);
    assert.equal(brandKitProblem({ ...kit, brand_name: '', brand_url: 'http://example.co.uk/shop?x=1', image_file: 'ab12cd34ef56.webp' }), null);
  });

  it('rejects each bad field, naming it', () => {
    const bad: [Partial<BrandKitInput>, RegExp][] = [
      [{ kit_id: 'kit_2' }, /kit_id "kit_2" must be kit_default/],
      [{ brand_url: '' }, /brand_url is empty/],
      [{ brand_url: 'magicspoon.com' }, /brand_url "magicspoon.com" must be an http\(s\) address/],
      [{ brand_url: 'ftp://magicspoon.com' }, /must be an http\(s\) address/],
      [{ brand_url: `https://a.com/${'x'.repeat(300)}` }, /brand_url is \d+ characters, more than 300/],
      [{ brand_name: 'Magic\nSpoon' }, /brand_name must be one line/],
      [{ image_file: '../etc.png' }, /image_file/],
      [{ image_file: 'ab12cd34ef56.gif' }, /image_file/],
      [{ image_sha: 'XYZ' }, /image_sha/],
      [{ image_file: '000000000000.png' }, /image_file must start with image_sha/],
    ];
    for (const [patch, re] of bad) assert.match(brandKitProblem({ ...kit, ...patch }) ?? '', re, JSON.stringify(patch));
  });
});

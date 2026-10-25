// Run: npx tsx --test app/sim/_lib/selectors.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArmRow, ArmStat, CreativeRow, Decision, Learning, Round, Run, SegmentRow } from '@/lib/spacetime/bindings/types';
import {
  CONTROL_COLOR,
  headerStats,
  leaderboard,
  learningsFeed,
  memoryLines,
  riverSeries,
  shopperAndMemory,
  shopperHistory,
  ticker,
  withoutLine,
} from './selectors';
import { CPM_USD } from './format';
import { type PinnedCapture, pinnedFor } from './pinned';

const arm = (armId: string, strategy = 'steal', angle = 'taste_indulgence', hook = 'testimonial') =>
  ({ armId, strategy, angle, hook }) as unknown as ArmRow;
const creative = (creativeId: string, armId: string, extra: Partial<CreativeRow> = {}) =>
  ({ creativeId, armId, brandId: 'brd_magic_spoon', headline: `Ad ${creativeId}`, learningIds: '[]', roundCreated: 0, ...extra }) as CreativeRow;
const feed = (shopperId: string, tick: number, creativeId: string, action: string, pTap = 0.02, draw = 0.5): Decision =>
  ({
    runId: 'run_t',
    round: Math.floor(tick / 3),
    tick,
    shopperId,
    kind: 'feed',
    creativeId,
    options: JSON.stringify({ state_hash: 'h', order: [creativeId, 'crv_rival'] }),
    pRaw: JSON.stringify({ tap: { [creativeId]: 0.6 }, believes: 0.4 }),
    pCal: JSON.stringify({ tap: { [creativeId]: pTap } }),
    draw: JSON.stringify({ tap: draw }),
    action,
    believesClaim: 0.4,
    objection: undefined,
    latencyMs: 80,
    cacheHit: tick % 2 === 0,
  }) as Decision;
const page = (shopperId: string, tick: number, creativeId: string, action: string): Decision =>
  ({
    ...feed(shopperId, tick, creativeId, action),
    kind: 'page',
    options: JSON.stringify({ state_hash: 'p', objections: ['price'] }),
    pRaw: JSON.stringify({ stay: 0.7, buy: 0.4, objection: { price: 0.6 } }),
    pCal: JSON.stringify({ stay: 0.55, buy: 0.1, guard: 1 }),
    draw: JSON.stringify({ stay: 0.3, buy: 0.05 }),
    objection: 'price',
  }) as Decision;

const arms = [arm('arm_00', 'control'), arm('arm_01'), arm('arm_02', 'steal', 'price_value', 'offer_led')];
const creatives = [creative('crv_c', 'arm_00'), creative('crv_1', 'arm_01'), creative('crv_2', 'arm_02')];

test('riverSeries counts feed impressions per arm per day, control first', () => {
  const decisions = [
    feed('s1', 0, 'crv_1', 'scroll'),
    feed('s2', 0, 'crv_c', 'scroll'),
    page('s2', 0, 'crv_c', 'not_tapped'),
    feed('s3', 1, 'crv_1', 'tap'),
    feed('s4', 1, 'crv_2', 'scroll'),
  ];
  const { series, days } = riverSeries(decisions, creatives, arms);
  assert.equal(days, 2);
  assert.deepEqual(series.map((s) => s.id), ['arm_00', 'arm_01', 'arm_02']);
  assert.equal(series[0]!.color, CONTROL_COLOR);
  assert.deepEqual(series[0]!.perDay, [1, 0]);
  assert.deepEqual(series[1]!.perDay, [1, 1]);
  assert.deepEqual(series[2]!.perDay, [0, 1]);
});

test('leaderboard uses the latest round, ranks by post mean, names the top recipe by P(best)', () => {
  const stat = (armId: string, round: number, postMean: number, pBest: number): ArmStat =>
    ({ runId: 'run_t', round, segmentId: 'seg_a', armId, impressions: 100, postMean, postSd: postMean / 4, pBest, estCostPerOrderUsd: CPM_USD / 1000 / postMean }) as unknown as ArmStat;
  const segments = [{ segmentId: 'seg_a', name: 'Seg A' }] as SegmentRow[];
  const boards = leaderboard(
    [stat('arm_01', 0, 0.9, 0.9), stat('arm_00', 1, 0.002, 0.5), stat('arm_01', 1, 0.001, 0.1), stat('arm_02', 1, 0.0005, 0.4)],
    arms,
    segments,
  );
  assert.equal(boards.length, 1);
  const b = boards[0]!;
  assert.equal(b.round, 1);
  assert.deepEqual(b.rows.map((r) => r.armId), ['arm_00', 'arm_01', 'arm_02']);
  assert.equal(b.control?.armId, 'arm_00');
  // Top recipe skips the control even when it has the highest P(best).
  assert.equal(b.topRecipe?.armId, 'arm_02');
  const r1 = b.rows[1]!;
  assert.ok(Math.abs(r1.cpoLow! - CPM_USD / 1000 / 0.0015) < 1e-9);
  assert.ok(Math.abs(r1.cpoHigh! - CPM_USD / 1000 / 0.0005) < 1e-9);
});

test('ticker is newest first and joins each impression to its page call', () => {
  const decisions = [feed('s1', 0, 'crv_1', 'scroll'), feed('s2', 1, 'crv_2', 'tap', 0.03, 0.01), page('s2', 1, 'crv_2', 'stay')];
  const rows = ticker(decisions, creatives, [{ brandId: 'brd_magic_spoon', name: 'Magic Spoon' }] as never, new Map([['s2', 'Sam B.']]));
  assert.deepEqual(rows.map((r) => r.shopperId), ['s2', 's1']);
  assert.equal(rows[0]!.shopperName, 'Sam B.');
  assert.equal(rows[0]!.pTap, 0.03);
  assert.equal(rows[0]!.draw, 0.01);
  assert.equal(rows[0]!.pageAction, 'stay');
  assert.equal(rows[0]!.pStay, 0.55);
  assert.equal(rows[1]!.pageAction, null);
});

test('shopperHistory lists one shopper oldest first with raw, calibrated and dice', () => {
  const decisions = [feed('s1', 4, 'crv_1', 'tap'), page('s1', 4, 'crv_1', 'bounce'), feed('s1', 1, 'crv_2', 'scroll'), feed('s9', 2, 'crv_1', 'scroll')];
  const steps = shopperHistory(decisions, 's1');
  assert.deepEqual(steps.map((s) => s.tick), [1, 4]);
  assert.deepEqual(steps[1]!.tap, { raw: 0.6, cal: 0.02, draw: 0.5 });
  assert.deepEqual(steps[1]!.stay, { raw: 0.7, cal: 0.55, draw: 0.3 });
  assert.equal(steps[1]!.buy?.guarded, false);
  assert.equal(steps[1]!.objection, 'price');
  assert.equal(steps[0]!.stay, null);
});

const STATE = [
  'SHOPPER\nSam B. A parent.\nIn their own words: "x"\nCares a lot about: taste.\nShopping for a new cereal right now and wants to buy within a few days.',
  'MEMORY\nHas seen Magic Spoon ads twice this week.\nNo opinion of Magic Spoon yet.',
  'THEY TAPPED\nMagic Spoon: ad',
  'THE PAGE\nMagic Spoon Variety 4-Pack — $39 one-time.',
].join('\n\n');

test('memoryLines offers the need line and every MEMORY line', () => {
  assert.deepEqual(
    memoryLines(STATE).map((l) => l.text),
    ['Shopping for a new cereal right now and wants to buy within a few days.', 'Has seen Magic Spoon ads twice this week.', 'No opinion of Magic Spoon yet.'],
  );
});

test('withoutLine and shopperAndMemory drop exactly one line', () => {
  const line = 'No opinion of Magic Spoon yet.';
  const page = withoutLine(STATE, line);
  assert.ok(!page.includes(line));
  assert.ok(page.includes('THE PAGE\n'));
  assert.equal(page.split('\n').length, STATE.split('\n').length - 1);
  const feedPart = shopperAndMemory(STATE, line);
  assert.ok(feedPart.startsWith('SHOPPER\n') && feedPart.includes('\n\nMEMORY\nHas seen'));
  assert.ok(!feedPart.includes('THEY TAPPED') && !feedPart.includes(line));
});

test('learningsFeed is newest first, marks live ones and links the creatives that used them', () => {
  const learning = (learningId: string, validFromRound: number, validToRound?: number) =>
    ({ learningId, runId: 'run_t', segmentId: 'seg_a', kind: 'objection', evidence: '{}', validFromRound, validToRound }) as Learning;
  const items = learningsFeed(
    [learning('lrn_a_v1', 0, 1), learning('lrn_a_v2', 1)],
    [creative('crv_new', 'arm_01', { learningIds: JSON.stringify(['lrn_a_v2']) }), creative('crv_old', 'arm_01')],
  );
  assert.deepEqual(items.map((l) => l.learningId), ['lrn_a_v2', 'lrn_a_v1']);
  assert.deepEqual(items.map((l) => l.live), [true, false]);
  assert.deepEqual(items[0]!.usedBy.map((c) => c.creativeId), ['crv_new']);
  assert.equal(items[1]!.usedBy.length, 0);
});

test('headerStats: exact cost for done rounds, an estimate for a running one', () => {
  const run = { ticksPerRound: 3, roundsPlanned: 5, calibration: JSON.stringify({ probe_jev: { calls: 10, input_tokens: 1_000_000 } }) } as Run;
  const rounds = [
    { round: 0, status: 'done', summary: JSON.stringify({ jev: { cost_usd: 0.5 } }) },
    { round: 1, status: 'running', summary: '' },
  ] as Round[];
  const decisions = [feed('s1', 0, 'crv_1', 'scroll'), feed('s1', 3, 'crv_1', 'scroll'), feed('s2', 4, 'crv_1', 'scroll')];
  const h = headerStats(run, rounds, decisions);
  assert.equal(h.round, 1);
  assert.equal(h.roundStatus, 'running');
  assert.equal(h.simDay, 2);
  assert.equal(h.calls, 13);
  assert.equal(h.costIsEstimate, true);
  assert.ok(Math.abs(h.costUsd - (0.042 + 0.5 + (2 * 700 * 0.042) / 1e6)) < 1e-12);
  assert.deepEqual(h.callsPerDay, [1, 0, 0, 1, 1]);
  assert.equal(h.cacheHitRate, 2 / 3);
});

test('pinnedFor holds only for a run whose decisions read the captured states', () => {
  const capture = {
    shopper: { shopper_id: 'shp_7' },
    before: { tick: 4, feed: { state_hash: 'hash_before' } },
    after: { tick: 9, feed: { state_hash: 'hash_after' } },
  } as unknown as PinnedCapture;
  const row = (tick: number, hash: string, shopperId = 'shp_7', kind = 'feed') =>
    ({ shopperId, tick, kind, options: JSON.stringify({ state_hash: hash }) }) as Decision;
  // The source run, or a replay of it: both days read the captured states.
  assert.equal(pinnedFor(capture, [row(4, 'hash_before'), row(4, 'p', 'shp_7', 'page'), row(9, 'hash_after')]), capture);
  // Same ids, different run: a state differs.
  assert.equal(pinnedFor(capture, [row(4, 'hash_before'), row(9, 'other')]), null);
  // Mid-replay, before the "after" day is written.
  assert.equal(pinnedFor(capture, [row(4, 'hash_before')]), null);
  assert.equal(pinnedFor(null, [row(4, 'hash_before')]), null);
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { GET } from '@/app/api/sim/ad-image/[id]/route';
import { imageRunFor, runSignature } from '@/app/sim/_lib/adImages';
import { type Ad, type ArmStat, type Decision, scoreAds, topRound0, winners } from '@/scripts/sim-images-select';

// One impression of `creative` shown to `shopper` on `tick`: a feed row with our tap chance and
// the page row with stay and buy, so its reward is tap × stay × buy.
const impression = (round: number, tick: number, shopper: string, creative: string, tap: number, stay = 0.5, buy = 0.1): Decision[] => [
  { round, tick, shopper_id: shopper, kind: 'feed', creative_id: creative, p_cal: JSON.stringify({ tap: { [creative]: tap } }) },
  { round, tick, shopper_id: shopper, kind: 'page', creative_id: creative, p_cal: JSON.stringify({ stay, buy, guard: 1 }) },
];
const ad = (creative_id: string, arm_id: string, segment_id: string, round_created = 0, origin = 'generated', status = 'ranked'): Ad => ({
  creative_id,
  arm_id,
  segment_id,
  origin,
  status,
  round_created,
});

describe('sim:images selection', () => {
  it('scores an ad by its mean tap × stay × buy', () => {
    const d = [...impression(0, 0, 's1', 'cr_a', 0.02), ...impression(0, 1, 's2', 'cr_a', 0.04)];
    const s = scoreAds(d, () => true).get('cr_a')!;
    assert.equal(s.n, 2);
    assert.ok(Math.abs(s.mean - (0.02 + 0.04) * 0.05 / 2) < 1e-12);
  });

  it('round 0: ranks only ranked round-0 generated ads, by warm-up reward, and needs a few impressions', () => {
    const ads = [ad('cr_hi', 'arm_x', 'seg_a'), ad('cr_lo', 'arm_y', 'seg_a'), ad('cr_late', 'arm_x', 'seg_a', 2), ad('cr_live', 'arm_control', '', 0, 'brand_live'), ad('cr_thin', 'arm_z', 'seg_a')];
    const d: Decision[] = [];
    for (let i = 0; i < 6; i++) d.push(...impression(0, i, `s${i}`, 'cr_hi', 0.05), ...impression(0, i, `t${i}`, 'cr_lo', 0.01));
    for (let i = 0; i < 6; i++) d.push(...impression(0, i, `u${i}`, 'cr_live', 0.9), ...impression(3, i, `v${i}`, 'cr_late', 0.9));
    d.push(...impression(0, 0, 'w', 'cr_thin', 0.9));
    assert.deepEqual(topRound0(d, ads).map((s) => s.creative_id), ['cr_hi', 'cr_lo']);
    assert.deepEqual(topRound0(d, ads, 1).map((s) => s.creative_id), ['cr_hi']);
  });

  it("winners: each segment's top recipe by posterior mean (never the control), then its best-rewarded ad there", () => {
    const ads = [ad('cr_x0', 'arm_x', 'seg_a'), ad('cr_x1', 'arm_x', 'seg_a', 1), ad('cr_y0', 'arm_y', 'seg_a'), ad('cr_c', 'arm_control', '', 0, 'brand_live')];
    const stats: ArmStat[] = [
      { round: 4, segment_id: 'seg_a', arm_id: 'arm_y', post_mean: 9, est_cost_per_order_usd: 1 },
      { round: 5, segment_id: 'seg_a', arm_id: 'arm_control', post_mean: 99, est_cost_per_order_usd: 90 },
      { round: 5, segment_id: 'seg_a', arm_id: 'arm_x', post_mean: 2, est_cost_per_order_usd: 30 },
      { round: 5, segment_id: 'seg_a', arm_id: 'arm_y', post_mean: 1, est_cost_per_order_usd: 60 },
    ];
    const d: Decision[] = [];
    for (let i = 0; i < 30; i++) d.push(...impression(5, i, `a${i}`, 'cr_x0', 0.01), ...impression(5, i, `b${i}`, 'cr_x1', 0.03));
    const segmentOf = new Map([...Array(30)].flatMap((_, i) => [[`a${i}`, 'seg_a'], [`b${i}`, 'seg_a']] as [string, string][]));
    const [w] = winners(d, ads, stats, segmentOf, 'arm_control');
    assert.equal(w!.arm_id, 'arm_x');
    assert.equal(w!.creative_id, 'cr_x1');
    assert.equal(w!.cpo, 30);
    assert.equal(w!.control_cpo, 90);
  });

  it('winners: below the impression floor, the most-shown ad wins', () => {
    const ads = [ad('cr_x0', 'arm_x', 'seg_a'), ad('cr_x1', 'arm_x', 'seg_a', 1)];
    const stats: ArmStat[] = [{ round: 1, segment_id: 'seg_a', arm_id: 'arm_x', post_mean: 1, est_cost_per_order_usd: 10 }];
    const d = [...impression(1, 0, 'a', 'cr_x0', 0.01), ...impression(1, 1, 'a', 'cr_x0', 0.01), ...impression(1, 2, 'b', 'cr_x1', 0.9)];
    const [w] = winners(d, ads, stats, new Map([['a', 'seg_a'], ['b', 'seg_a']]), 'arm_control');
    assert.equal(w!.creative_id, 'cr_x0');
  });
});

describe('/api/sim/ad-image', () => {
  const get = (id: string) => GET(new Request('http://x'), { params: Promise.resolve({ id }) });
  it('refuses ids that could leave the image folder', async () => {
    for (const id of ['../.env.local', 'a/b', 'A', '', 'x'.repeat(200)]) assert.equal((await get(id)).status, 404);
  });
  it('404s an unknown image and serves a known one as PNG', async () => {
    assert.equal((await get('cr_does_not_exist')).status, 404);
    const sidecar = JSON.parse(await readFile('sim/demo/ad-images.json', 'utf8')) as { images: Record<string, unknown> };
    const known = Object.keys(sidecar.images)[0];
    // The PNGs are git-ignored (data/ad-images/), so only the machine that ran sim:images has them.
    if (!known || !existsSync(`data/ad-images/${known}.png`)) return;
    const res = await get(known);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/png');
  });
});

describe('ad images on replays', () => {
  const feed = (run: string) =>
    [3, 1, 2].flatMap((n) => [
      { tick: 0, shopper: `shp_${n}`, options: JSON.stringify({ state_hash: `${run}_${n}`.padEnd(20, 'x') }) },
      { tick: 1, shopper: `shp_${n}`, options: JSON.stringify({ state_hash: `late_${n}` }) },
    ]);
  it("a replay reproduces its source run's signature; another run doesn't", () => {
    assert.equal(runSignature(feed('a')), runSignature([...feed('a')].reverse()));
    assert.notEqual(runSignature(feed('a')), runSignature(feed('b')));
  });
  it('picks the run itself, else the run whose signature matches, else nothing', () => {
    const runs = { run_src: { signature: runSignature(feed('a')) } };
    const has = (id: string) => id === 'run_src';
    assert.equal(imageRunFor('run_src', '', runs, has), 'run_src');
    assert.equal(imageRunFor('run_src_replay', runSignature(feed('a')), runs, has), 'run_src');
    assert.equal(imageRunFor('run_other', runSignature(feed('b')), runs, has), null);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runFixtureSmoke } from '@/worker/creatives/smoke';

describe('fixture smoke test (creative-brief.json → creative-output.json)', () => {
  it('reproduces the fixture: rows, packs, prompts, copy requests and all 4 creatives', async () => {
    const { mismatches, creatives, calls } = await runFixtureSmoke();
    assert.deepEqual(mismatches, []);
    assert.equal(creatives.length, 4);
    // 4 copy calls plus the statistic group's retry after the invented "15g".
    assert.equal(calls, 5);
    assert.deepEqual(
      creatives.map((creative) => creative.packFingerprint.slice(0, 8)),
      ['6154a1af', '6154a1af', '60a0cd12', '60a0cd12'],
    );
  });
});

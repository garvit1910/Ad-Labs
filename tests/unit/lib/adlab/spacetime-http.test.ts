import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeSqlResults, isLocalUri, sqlString } from '@/lib/adlab/spacetime-http';

// Schemas exactly as adlab-calhacks13's /sql endpoint returns them.
const option = (inner: object) => ({
  Sum: { variants: [{ name: { some: 'some' }, algebraic_type: inner }, { name: { some: 'none' }, algebraic_type: { Product: { elements: [] } } }] },
});
const timestamp = { Product: { elements: [{ name: { some: '__timestamp_micros_since_unix_epoch__' }, algebraic_type: { I64: [] } }] } };
const field = (name: string, algebraic_type: object) => ({ name: { some: name }, algebraic_type });
const TASK_SCHEMA = {
  elements: [
    field('task_id', { String: [] }),
    field('run_id', { String: [] }),
    field('kind', { String: [] }),
    field('payload', { String: [] }),
    field('status', { String: [] }),
    field('claimed_by', option({ String: [] })),
    field('result', option({ String: [] })),
    field('created_at', timestamp),
    field('updated_at', timestamp),
  ],
};
const LEARNING_SCHEMA = {
  elements: [
    field('learning_id', { String: [] }),
    field('segment_id', { String: [] }),
    field('arm_id', option({ String: [] })),
    field('valid_from_round', { U32: [] }),
    field('valid_to_round', option({ U32: [] })),
  ],
};
const micros = Date.UTC(2026, 9, 24, 20, 0, 0) * 1000;

describe('decodeSqlResults', () => {
  it('decodes the live server’s [tag, value] sums: some is [0, v], none is [1, []]', () => {
    const rows = decodeSqlResults([
      {
        schema: TASK_SCHEMA,
        rows: [
          ['tsk_gen_run_1_r0', 'run_1', 'generate_creatives', '{}', 'claimed', [0, 'copywriter'], [1, []], [micros], [micros + 5_000_000]],
          ['tsk_run_run_1_r1', 'run_1', 'run_round', '{}', 'done', [1, []], [0, '{"ok":true}'], [micros], [micros]],
        ],
      },
    ]);
    assert.deepEqual(rows[0], {
      task_id: 'tsk_gen_run_1_r0',
      run_id: 'run_1',
      kind: 'generate_creatives',
      payload: '{}',
      status: 'claimed',
      claimed_by: 'copywriter',
      result: null,
      created_at: '2026-10-24T20:00:00.000Z',
      updated_at: '2026-10-24T20:00:05.000Z',
    });
    assert.equal(rows[1].claimed_by, null);
    assert.equal(rows[1].result, '{"ok":true}');
  });

  it('keeps a learning with no arm segment-wide, and a number option as a number', () => {
    const rows = decodeSqlResults([
      {
        schema: LEARNING_SCHEMA,
        rows: [
          ['lrn_1', 'seg_a', [1, []], 1, [1, []]],
          ['lrn_2', 'seg_a', [0, 'arm_x'], 1, [0, 3]],
        ],
      },
    ]);
    assert.deepEqual(rows, [
      { learning_id: 'lrn_1', segment_id: 'seg_a', arm_id: null, valid_from_round: 1, valid_to_round: null },
      { learning_id: 'lrn_2', segment_id: 'seg_a', arm_id: 'arm_x', valid_from_round: 1, valid_to_round: 3 },
    ]);
  });

  it('still reads one-key object sums and rows keyed by name', () => {
    const rows = decodeSqlResults([
      {
        schema: { Product: { elements: [field('brand_id', { String: [] }), field('note', option({ String: [] }))] } },
        rows: [
          { brand_id: 'br_magic_spoon', note: { some: 'hi' } },
          { brand_id: 'br_ghost', note: { 1: [] } },
        ],
      },
    ]);
    assert.deepEqual(rows, [
      { brand_id: 'br_magic_spoon', note: 'hi' },
      { brand_id: 'br_ghost', note: null },
    ]);
  });
});

describe('sqlString and isLocalUri', () => {
  it("quotes and escapes '", () => {
    assert.equal(sqlString("run_o'neil"), "'run_o''neil'");
  });
  it('treats only localhost as the local bench', () => {
    assert.equal(isLocalUri('http://127.0.0.1:3100'), true);
    assert.equal(isLocalUri('http://localhost:3000'), true);
    assert.equal(isLocalUri('https://maincloud.spacetimedb.com'), false);
    assert.equal(isLocalUri('not a url'), false);
  });
});

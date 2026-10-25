import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeSqlResults, sqlString } from '@/worker/creatives/spacetime';

// The `task` schema exactly as adlab-calhacks13's /sql endpoint returns it.
const option = { Sum: { variants: [{ name: { some: 'some' }, algebraic_type: { String: [] } }, { name: { some: 'none' }, algebraic_type: { Product: { elements: [] } } }] } };
const timestamp = { Product: { elements: [{ name: { some: '__timestamp_micros_since_unix_epoch__' }, algebraic_type: { I64: [] } }] } };
const field = (name: string, algebraic_type: object) => ({ name: { some: name }, algebraic_type });
const TASK_SCHEMA = {
  elements: [
    field('task_id', { String: [] }),
    field('run_id', { String: [] }),
    field('kind', { String: [] }),
    field('payload', { String: [] }),
    field('status', { String: [] }),
    field('claimed_by', option),
    field('result', option),
    field('created_at', timestamp),
    field('updated_at', timestamp),
  ],
};

describe('decodeSqlResults', () => {
  it('decodes products in element order, options and timestamps', () => {
    const micros = Date.UTC(2026, 9, 24, 20, 0, 0) * 1000;
    const rows = decodeSqlResults([
      {
        schema: TASK_SCHEMA,
        rows: [
          ['tsk_gen_run_1_r0', 'run_1', 'generate_creatives', '{}', 'claimed', { 0: 'copywriter' }, { 1: [] }, [micros], [micros + 5_000_000]],
          ['tsk_run_run_1_r1', 'run_1', 'run_round', '{}', 'queued', { none: [] }, { some: '{"ok":true}' }, [micros], [micros]],
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

  it('accepts a product wrapped in Product and rows keyed by name', () => {
    const rows = decodeSqlResults([
      {
        schema: { Product: { elements: [field('brand_id', { String: [] }), field('is_client', { Bool: [] })] } },
        rows: [{ brand_id: 'br_magic_spoon', is_client: true }],
      },
    ]);
    assert.deepEqual(rows, [{ brand_id: 'br_magic_spoon', is_client: true }]);
  });
});

describe('sqlString', () => {
  it("quotes and escapes '", () => {
    assert.equal(sqlString("run_o'neil"), "'run_o''neil'");
  });
});

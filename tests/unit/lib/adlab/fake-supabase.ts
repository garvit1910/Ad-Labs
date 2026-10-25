import type { SupabaseClient } from '@supabase/supabase-js';

// A tiny in-memory stand-in for the supabase-js query builder: select / insert / update with
// eq, in, lte, not(col, 'is', null), order, limit, maybeSingle. Every access is logged, so tests
// can assert which tables were read and that nothing was written.

type Row = Record<string, unknown>;
export interface FakeOp {
  table: string;
  op: 'select' | 'insert' | 'update';
  patch?: Row;
}

export function fakeSupabase(tables: Record<string, Row[]>) {
  const ops: FakeOp[] = [];
  const db = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let op: FakeOp['op'] = 'select';
      let patch: Row | undefined;
      let inserted: Row | undefined;
      let limit = Infinity;
      const rows = () => (tables[table] ??= []);
      const run = () => {
        if (op === 'insert') {
          rows().push(inserted!);
          return [inserted!];
        }
        const hit = rows().filter((r) => filters.every((f) => f(r)));
        if (op === 'update') for (const r of hit) Object.assign(r, patch);
        return hit.slice(0, limit);
      };
      const builder = {
        select() {
          return builder;
        },
        insert(row: Row) {
          op = 'insert';
          inserted = { ...row };
          ops.push({ table, op, patch: inserted });
          return builder;
        },
        update(p: Row) {
          op = 'update';
          patch = p;
          ops.push({ table, op, patch: p });
          return builder;
        },
        eq(col: string, v: unknown) {
          filters.push((r) => r[col] === v);
          return builder;
        },
        in(col: string, vs: unknown[]) {
          filters.push((r) => vs.includes(r[col]));
          return builder;
        },
        lte(col: string, v: string) {
          filters.push((r) => String(r[col] ?? '') <= v);
          return builder;
        },
        not(col: string, operator: string, v: unknown) {
          if (operator === 'is' && v === null) filters.push((r) => r[col] !== null && r[col] !== undefined);
          return builder;
        },
        order() {
          return builder;
        },
        limit(n: number) {
          limit = n;
          return builder;
        },
        single() {
          if (op === 'select') ops.push({ table, op });
          return Promise.resolve({ data: run()[0] ?? null, error: null });
        },
        maybeSingle() {
          if (op === 'select') ops.push({ table, op });
          return Promise.resolve({ data: run()[0] ?? null, error: null });
        },
        then<T>(resolve: (v: { data: Row[]; error: null }) => T, reject?: (e: unknown) => T) {
          if (op === 'select') ops.push({ table, op });
          return Promise.resolve({ data: run(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, ops, tables };
}

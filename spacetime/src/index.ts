import { schema } from 'spacetimedb/server';
import { tablesA } from './tables_a';
import { tablesB } from './tables_b';

// One module, two files: A owns tables_a.ts, B owns tables_b.ts.
const spacetimedb = schema({ ...tablesA, ...tablesB });
export default spacetimedb;

// Liveness check for `npm run check:connections`; touches no table.
export const ping = spacetimedb.reducer(_ctx => {
  console.info('pong');
});

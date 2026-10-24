import { schema } from 'spacetimedb/server';
import { tablesA } from './tables_a';
import { tablesB } from './tables_b';
import { reducersB } from './reducers_b';

// One module, two files: A owns tables_a.ts, B owns tables_b.ts.
const spacetimedb = schema({ ...tablesA, ...tablesB });
export default spacetimedb;

// Liveness check for `npm run check:connections`; touches no table.
export const ping = spacetimedb.reducer(_ctx => {
  console.info('pong');
});

// B's reducers (reducers_b.ts). SpacetimeDB registers a reducer only through this file's
// exports, so they are built here from the schema and exported by name.
export const {
  upsertProducts,
  upsertCreativePerceptions,
  upsertRun,
  startRound,
  finishRound,
  upsertShoppers,
  insertDecisions,
  replaceArmStats,
  upsertLearnings,
  enqueueTask,
  claimTask,
  completeTask,
  failTask,
} = reducersB(spacetimedb);

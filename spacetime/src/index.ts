import spacetimedb from './schema';

// Module entry: the schema plus every reducer. Each side's reducers file is re-exported here.
export { default } from './schema';
export * from './reducers_a';
export * from './reducers_b';

// Liveness check for `npm run check:connections`; touches no table.
export const ping = spacetimedb.reducer(_ctx => {
  console.info('pong');
});

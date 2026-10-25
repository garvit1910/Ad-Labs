// The shared SpacetimeDB database (docs/PLAN.md "Status"). Neither value is a secret, so both
// default to the live database and no laptop needs new env. The browser only sees NEXT_PUBLIC_*
// variables; the server also reads A0's SPACETIMEDB_*. The SDK turns https:// into wss:// itself.
//
// The typed client is generated into ./bindings by `npm run spacetime:generate`; regenerate it
// after every module change and never edit it by hand.
export const SPACETIMEDB_URI =
  process.env.NEXT_PUBLIC_SPACETIMEDB_URI ||
  process.env.SPACETIMEDB_URI ||
  'https://maincloud.spacetimedb.com';

export const SPACETIMEDB_DB_NAME =
  process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME ||
  process.env.SPACETIMEDB_DB_NAME ||
  'adlab-calhacks13';

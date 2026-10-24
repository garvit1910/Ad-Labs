import { schema } from 'spacetimedb/server';
import { tablesA } from './tables_a';
import { tablesB } from './tables_b';

// One module, two table files: A owns tables_a.ts, B owns tables_b.ts. Reducers live in
// reducers_a.ts / reducers_b.ts and import this schema; defining them inside the table files
// would be an import cycle (this file imports both).
const spacetimedb = schema({ ...tablesA, ...tablesB });
export default spacetimedb;

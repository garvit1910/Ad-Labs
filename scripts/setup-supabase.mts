import { loadEnv } from "./env.mjs";
import { supabasePg } from "./pg.mjs";

// One-off, idempotent: enable pgvector in the Supabase project. Tables come in A1's migrations.
loadEnv();
const client = supabasePg();
await client.connect();
try {
  await client.query("create extension if not exists vector with schema extensions");
  const { rows } = await client.query<{ extversion: string; schema: string }>(
    `select e.extversion, n.nspname as schema
       from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'vector'`,
  );
  const row = rows[0];
  if (!row) throw new Error("vector extension missing after create");
  console.log(`pgvector ${row.extversion} enabled in schema "${row.schema}"`);
} finally {
  await client.end();
}

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, REPO_ROOT } from "../scripts/env.mjs";
import { supabasePg } from "../scripts/pg.mjs";

// Applies supabase/migrations/*.sql in name order over SUPABASE_CONNECTION_STRING (there is no
// Supabase CLI here). Each file runs in its own transaction; applied names are recorded in
// adlab_meta.migrations, a schema PostgREST doesn't expose, so a rerun applies only new files.
loadEnv();
const dir = join(REPO_ROOT, "supabase", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const client = supabasePg();
await client.connect();
try {
  await client.query(`create schema if not exists adlab_meta;
    create table if not exists adlab_meta.migrations (name text primary key, applied_at timestamptz not null default now())`);
  const { rows } = await client.query<{ name: string }>("select name from adlab_meta.migrations");
  const applied = new Set(rows.map((r) => r.name));
  const pending = files.filter((f) => !applied.has(f));

  for (const file of pending) {
    await client.query("begin");
    try {
      await client.query(readFileSync(join(dir, file), "utf8"));
      await client.query("insert into adlab_meta.migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`applied ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw new Error(`${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (pending.length > 0) await client.query("notify pgrst, 'reload schema'");
  console.log(pending.length > 0 ? `${pending.length} applied` : `nothing to apply (${files.length} already applied)`);
} finally {
  await client.end();
}

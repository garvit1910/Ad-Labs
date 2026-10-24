import pg from "pg";
import { requireEnv } from "./env.mjs";

// Supabase serves Postgres over TLS with its own CA, so the chain isn't verified here.
export function supabasePg(): pg.Client {
  return new pg.Client({
    connectionString: requireEnv("SUPABASE_CONNECTION_STRING"),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
}

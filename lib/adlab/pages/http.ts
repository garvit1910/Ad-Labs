import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z, ZodError } from 'zod';
import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { serviceSupabase } from '@/lib/adlab/supabase';

/**
 * Server-only helpers for the Brand Identity and Competitor Analysis page
 * routes (A7). Every copied hook POSTs JSON and unwraps `{ data }`; on a
 * non-OK status it throws with the body's `{ reason, code }`. The routes read
 * live Supabase only (no fixture mode), always scoped to ADLAB_ORG_ID: the
 * organizationId a client sends is ignored. Never import this from client code.
 */

export class PageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PageError';
  }
}

/** 404 that the copied hooks read as "hide this chapter". */
export const notAvailable = (reason: string) => new PageError(404, 'NOT_AVAILABLE', reason);

/** A Supabase query error as a 500 PageError. */
export function dbError(what: string, error: { message: string }): PageError {
  return new PageError(500, 'DATABASE_QUERY_FAILED', `${what}: ${error.message}`);
}

let client: SupabaseClient | undefined;

/** Lazy, memoized service-role client: never built at import time. */
export function pagesDb(): SupabaseClient {
  client ??= serviceSupabase();
  return client;
}

const HEADERS = { 'x-adlab-source': 'supabase', 'cache-control': 'no-store' } as const;

export function ok(data: unknown): NextResponse {
  return NextResponse.json({ data }, { headers: HEADERS });
}

export function fail(err: unknown): NextResponse {
  if (err instanceof PageError) {
    return NextResponse.json({ reason: err.message, code: err.code }, { status: err.status, headers: HEADERS });
  }
  if (err instanceof ZodError) {
    const reason = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return NextResponse.json({ reason, code: 'VALIDATION_FAILED' }, { status: 400, headers: HEADERS });
  }
  console.error('[pages]', err);
  // Supabase errors are plain objects, not Error instances.
  const message =
    err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
      ? err.message
      : String(err);
  return NextResponse.json({ reason: message, code: 'INTERNAL' }, { status: 500, headers: HEADERS });
}

async function readBody(req: Request): Promise<unknown> {
  if (req.method === 'GET') return Object.fromEntries(new URL(req.url).searchParams);
  return req.json().catch(() => ({}));
}

/**
 * Wrap a route handler: read the body (query string for GET), validate it with
 * `schema`, run `live`, and answer in the `{ data }` / `{ reason, code }`
 * envelope. `z.output<S>` keeps `.default()` fields non-optional in `live`.
 */
export function pageHandler<S extends z.ZodTypeAny>(opts: {
  schema: S;
  live: (body: z.output<S>, req: Request) => Promise<unknown>;
}): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      const body = opts.schema.parse(await readBody(req)) as z.output<S>;
      return ok(await opts.live(body, req));
    } catch (err) {
      return fail(err);
    }
  };
}

/** The brand_presence_profiles columns these routes read (the row is `select('*')`). */
export type ProfileRow = {
  id: string;
  brand_name: string | null;
  status: string;
  [column: string]: unknown;
};

/** Every brand profile in the org, most recently updated first. */
export async function loadProfiles(db: SupabaseClient): Promise<ProfileRow[]> {
  const { data, error } = await db
    .from('brand_presence_profiles')
    .select('*')
    .eq('organization_id', ADLAB_ORG_ID)
    .order('updated_at', { ascending: false });
  if (error) throw dbError('Failed to load brand presence profiles', error);
  return (data ?? []) as ProfileRow[];
}

export async function findProfile(db: SupabaseClient, brandProfileId: string): Promise<ProfileRow | null> {
  const { data, error } = await db
    .from('brand_presence_profiles')
    .select('*')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('id', brandProfileId)
    .maybeSingle();
  if (error) throw dbError('Failed to load brand profile', error);
  return (data as ProfileRow | null) ?? null;
}

export async function requireProfile(db: SupabaseClient, brandProfileId: string): Promise<ProfileRow> {
  const profile = await findProfile(db, brandProfileId);
  if (!profile) {
    throw new PageError(404, 'PROFILE_NOT_FOUND', 'That brand profile does not exist for this organization.');
  }
  return profile;
}

export const orgBody = z.object({ organizationId: z.string().optional() }).passthrough();
export const profileBody = z.object({ brandProfileId: z.string().uuid() }).passthrough();

import { NextResponse } from 'next/server';
import { ZodError, type z } from 'zod';
import { agentTarget, resetSpacetime } from '@/lib/adlab/agent-runtime';
import { RunRefusedError } from '@/lib/adlab/runs';
import { SpacetimeError } from '@/lib/adlab/spacetime-http';
import { runsAllowed } from '@/lib/adlab/targets';

// The agents' API envelope and errors (docs/AGENT_API.md): every response is {ok:true, data} or
// {ok:false, error, code}, with one code list the Python agents branch on.

export const ERROR_STATUS = {
  bad_request: 400,
  not_supported: 400,
  runs_not_allowed: 403,
  task_not_found: 404,
  db_has_run: 409,
  run_exists: 409,
  round0_incomplete: 409,
  not_ready: 409,
  claim_lost: 409,
  generate_failed: 502,
  upstream: 502,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const ok = (data: unknown) => NextResponse.json({ ok: true, data }, { headers: { 'cache-control': 'no-store' } });

function errorBody(code: ErrorCode, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, code, ...extra }, { status: ERROR_STATUS[code], headers: { 'cache-control': 'no-store' } });
}

export function fail(err: unknown): NextResponse {
  if (err instanceof ApiError) return errorBody(err.code, err.message, err.extra);
  if (err instanceof RunRefusedError) return errorBody(err.code, err.message);
  if (err instanceof ZodError) {
    const issues = err.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
    return errorBody('bad_request', issues);
  }
  if (err instanceof SpacetimeError) {
    if (err.status === 401) resetSpacetime();
    return errorBody('upstream', err.message);
  }
  console.error('[api/agent]', err);
  return errorBody('internal', err instanceof Error ? err.message : String(err));
}

/** Wraps a route body: its return value becomes {ok:true, data}; a throw becomes the error envelope. */
export function handle(fn: (req: Request) => Promise<unknown>): (req: Request) => Promise<NextResponse> {
  return async (req: Request) => {
    try {
      return ok(await fn(req));
    } catch (err) {
      return fail(err);
    }
  };
}

export async function parseJson<S extends z.ZodTypeAny>(req: Request, schema: S): Promise<z.output<S>> {
  const text = await req.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError('bad_request', 'the body is not valid JSON');
    }
  }
  return schema.parse(body);
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, schema: S): z.output<S> {
  return schema.parse(Object.fromEntries(new URL(req.url).searchParams));
}

/** Writing endpoints refuse on a database the agents may not touch (B's demo database, or any other). */
export function requireRunsAllowed(): void {
  const target = agentTarget();
  if (!runsAllowed(target)) throw new ApiError('runs_not_allowed', `agent writes are not allowed on ${target.label}`);
}

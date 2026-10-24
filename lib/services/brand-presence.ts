import { getAuthHeaders } from '@/hooks/use-organization-queries/auth-headers';

interface ResponseSchema<T> {
  safeParse: (_value: unknown) =>
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: Array<{ path: PropertyKey[]; message: string }> };
      };
}

/**
 * A non-OK response from a brand-presence route. The message is the route's
 * structured `reason` (so existing toasts read unchanged); `status` and
 * `code` let a caller branch on the failure — e.g. a read that must treat
 * the pre-release gate's 404 as "not available" rather than an error.
 */
export class BrandPresenceRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'BrandPresenceRequestError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Client-side fetch helper for the brand-presence API routes. Parallel of
 * `brandIdentityRequest` (deliberately not generalized — each route family
 * owns its prefix): unwraps the canonical `{ data }` envelope and throws the
 * structured `reason` on failure so hooks can surface it in toasts.
 */
export async function brandPresenceRequest<T>(
  path: string,
  body: Record<string, unknown>,
  schema?: ResponseSchema<T>,
): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/brand-presence/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as {
    data?: T;
    reason?: string;
    code?: string;
  } | null;

  if (!response.ok) {
    throw new BrandPresenceRequestError(
      payload?.reason ?? `Request to ${path} failed (${response.status})`,
      response.status,
      payload?.code,
    );
  }
  if (!payload || payload.data === undefined) {
    throw new Error(`Request to ${path} returned an empty response`);
  }
  if (!schema) return payload.data;
  const parsed = schema.safeParse(payload.data);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'data'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Response from ${path} failed validation: ${summary}`);
  }
  return parsed.data;
}

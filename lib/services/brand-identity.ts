import { getAuthHeaders } from '@/hooks/use-organization-queries/auth-headers';
import { CodedError, errorCodeFromBody } from '@/lib/i18n/localize-error';

/**
 * Client-side fetch helper for the brand-identity API routes. Unwraps the
 * canonical `{ data }` envelope and throws the structured `reason` on
 * failure (as a `CodedError` carrying the server `code`) so hooks can surface
 * it in toasts and localize it by code.
 */
export async function brandIdentityRequest<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/brand-identity/${path}`, {
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
    // CodedError keeps the server `code`/`status` so render sites can localize
    // the failure (`useLocalizeError`); the message stays the English reason.
    throw new CodedError(
      payload?.reason ?? `Request to ${path} failed (${response.status})`,
      {
        code: errorCodeFromBody(payload),
        status: response.status,
        remediation:
          payload && typeof (payload as { remediation?: unknown }).remediation === 'string'
            ? (payload as { remediation: string }).remediation
            : null,
      }
    );
  }
  if (!payload || payload.data === undefined) {
    throw new Error(`Request to ${path} returned an empty response`);
  }
  return payload.data;
}

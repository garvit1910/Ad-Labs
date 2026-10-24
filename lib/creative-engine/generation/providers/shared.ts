/**
 * Shared plumbing for the creative-image providers (and the synchronous
 * iterate route, which drives a provider edit() directly): the per-request
 * timeout resolution, the merged timeout/caller abort signal, and the bounded
 * error-body snippet reader.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Env-pinned per-request timeout (CREATIVE_GEN_REQUEST_TIMEOUT_MS), default 120s. */
export function resolveRequestTimeoutMs(): number {
  const raw = Number(process.env.CREATIVE_GEN_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Hard per-request timeout merged with the caller's signal.
 * `AbortSignal.timeout` owns its timer (no manual clear needed on resolve or
 * reject) and `AbortSignal.any` releases its listeners once either input
 * settles, so both paths are handled without a hand-rolled `withTimeout`.
 */
export function buildTimeoutSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

/**
 * HTTP statuses worth ONE more attempt (mirrors the retryable set in
 * `lib/llm/clients/openai-errors.ts`).
 */
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Both image providers throw a plain `Error` whose message embeds the status
 * in the `… failed (NNN): …` shape. Anchor on that shape — an arbitrary
 * 3-digit number elsewhere in a message is not a status.
 */
const PROVIDER_FAILURE_STATUS_RE = /failed \((\d{3})\)/;

/**
 * Is this image-provider rejection worth ONE bounded retry?
 *
 * Transient: `AbortSignal.timeout` firing (`TimeoutError`) or a `failed (NNN)`
 * message whose status is in the transient set. NEVER transient: `AbortError`
 * (caller-initiated cancel/pause — retrying would fight the pipeline's
 * cooperative-stop contract), config errors like a missing API key (plain
 * Error with no `(NNN)`), non-Errors, and any other status (400/401/403/404…).
 */
export function isTransientImageProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return false;
  if (error.name === 'TimeoutError') return true;
  const match = PROVIDER_FAILURE_STATUS_RE.exec(error.message);
  return match ? TRANSIENT_HTTP_STATUSES.has(Number(match[1])) : false;
}

/** Bounded error-body read for provider failure messages. */
export async function readErrorSnippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '<unreadable body>';
  }
}

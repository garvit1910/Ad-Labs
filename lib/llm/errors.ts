export const QUOTA_RETRY_DELAY_MS = 45 * 60_000;

export class LlmProviderError extends Error {
  readonly provider: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly remediation: string;
  readonly retryAfterMs?: number;

  constructor(params: {
    provider: string;
    code: string;
    reason: string;
    remediation: string;
    retryable?: boolean;
    status?: number;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(params.reason, params.cause ? { cause: params.cause } : undefined);
    this.name = "LlmProviderError";
    this.provider = params.provider;
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.status = params.status ?? 500;
    this.remediation = params.remediation;
    this.retryAfterMs = params.retryAfterMs;
  }
}

export function isRetryableLlmProviderError(
  error: unknown,
): error is LlmProviderError {
  return error instanceof LlmProviderError && error.retryable;
}

export function getLlmRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof LlmProviderError) {
    return error.retryAfterMs;
  }

  return undefined;
}

export type BrandSummaryErrorCode =
  | "INSUFFICIENT_CONTENT"
  | "WEBSITE_FETCH_RATE_LIMITED"
  | "WEBSITE_FETCH_FAILED"
  | "OPENAI_API_KEY_NOT_CONFIGURED"
  | "OPENAI_REQUEST_FAILED"
  | "OPENAI_INVALID_RESPONSE"
  | "DB_FETCH_FAILED"
  | "DB_UPDATE_FAILED"
  | "INVALID_JOB_PAYLOAD";

export class BrandSummaryError extends Error {
  readonly code: BrandSummaryErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly remediation: string;

  constructor(params: {
    code: BrandSummaryErrorCode;
    reason: string;
    remediation: string;
    retryable?: boolean;
    status?: number;
    cause?: unknown;
  }) {
    super(params.reason, params.cause ? { cause: params.cause } : undefined);
    this.name = "BrandSummaryError";
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.status = params.status ?? 500;
    this.remediation = params.remediation;
  }
}

export function isRetryableBrandSummaryError(
  error: unknown,
): error is BrandSummaryError {
  return error instanceof BrandSummaryError && error.retryable;
}

export function toBrandSummaryErrorResponse(error: unknown): {
  code: string;
  reason: string;
  remediation: string;
  status: number;
} {
  if (error instanceof BrandSummaryError) {
    return {
      code: error.code,
      reason: error.message,
      remediation: error.remediation,
      status: error.status,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    reason: error instanceof Error ? error.message : "Unknown error",
    remediation: "Retry the request. If the problem persists, contact support",
    status: 500,
  };
}

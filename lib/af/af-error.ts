/**
 * Structured error class for Agent-First routes.
 *
 * Provides factory methods for common HTTP error types.
 * Used by `withAfRoute` to auto-format structured error responses.
 */
/**
 * Optional canonical-state fields an error response carries next to
 * `code`/`reason`/`remediation` (e.g. a Google refusal's `errorCode`, field
 * path and requestId in `details`, plus `nextActions`), so an agent can act on
 * the provider's facts without parsing `reason`. Omitted fields are not sent.
 */
export interface AfErrorState {
  constraints?: Record<string, unknown>;
  nextActions?: string[];
  details?: Record<string, unknown>;
}

export class AfError extends Error {
  constructor(
    public readonly code: string,
    public readonly reason: string,
    public readonly remediation: string,
    public readonly httpStatus: number = 500,
    public readonly state?: AfErrorState
  ) {
    super(reason);
    this.name = 'AfError';
  }

  static notFound(entity: string, id?: string): AfError {
    return new AfError(
      'NOT_FOUND',
      `${entity}${id ? ` '${id}'` : ''} not found`,
      `Verify the ${entity.toLowerCase()} ID exists and you have access`,
      404
    );
  }

  static forbidden(reason?: string): AfError {
    return new AfError(
      'PERMISSION_DENIED',
      reason ?? 'You do not have permission to perform this action',
      'Contact the organization admin to request access',
      403
    );
  }

  static validation(reason: string, remediation?: string): AfError {
    return new AfError(
      'VALIDATION_ERROR',
      reason,
      remediation ?? 'Check the request body matches the expected schema',
      400
    );
  }

  /**
   * `remediation` defaults to the Bearer-token advice for user/agent callers;
   * webhook receivers pass their own (the sender has no Authorization header).
   */
  static unauthorized(reason?: string, remediation?: string): AfError {
    return new AfError(
      'UNAUTHORIZED',
      reason ?? 'Authentication required',
      remediation ?? 'Include a valid Bearer token in the Authorization header',
      401
    );
  }

  static serviceUnavailable(reason?: string, remediation?: string): AfError {
    return new AfError(
      'SERVICE_UNAVAILABLE',
      reason ?? 'The service is temporarily unavailable.',
      remediation ?? 'Retry the request. If the problem persists, contact support.',
      503
    );
  }

  static internal(reason?: string): AfError {
    return new AfError(
      'INTERNAL_ERROR',
      reason ?? 'An internal error occurred',
      'Retry the request. If the problem persists, contact support.',
      500
    );
  }
}

import { AgentRuleError } from '@/lib/adlab/agent-api';
import { CopywriterError } from '@/lib/adlab/copywriter';
import { ApiError } from './http';

/** Maps the agent libraries' own errors onto the API's codes; anything else passes through to handle(). */
export function asApiError(err: unknown): unknown {
  if (err instanceof AgentRuleError) return new ApiError('bad_request', err.message);
  if (err instanceof CopywriterError) return new ApiError(err.code, err.message);
  return err;
}

/** Runs `fn`, rethrowing the libraries' errors as ApiErrors. */
export async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asApiError(err);
  }
}

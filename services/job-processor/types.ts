/**
 * Ad Lab same-path stub (REUSE_MANIFEST §8.2): one `job_queue` row as the
 * worker hands it to a processor. Processors read only `id` and `payload`.
 */
export interface Job {
  id: string;
  type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  payload: { organizationId: string; [key: string]: unknown };
  claim_token?: string;
  created_at?: string;
  completed_at?: string;
  error_message?: string;
}

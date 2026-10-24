/**
 * Ad Lab same-path stub (REUSE_MANIFEST §8.2): Gemini video labelling is off.
 *
 * Throws a NON-retryable LlmProviderError, which the ad labeller treats as a
 * permanent per-video failure and labels that ad from its poster image
 * instead. A retryable error, or a plain Error, would fail the whole batch.
 */
import type { Candidate, ContentListUnion, GenerateContentConfig } from '@google/genai';
import { LlmProviderError } from '../errors';
import type { LlmRetryProfile } from './types';

export async function geminiGenerateContent(_params: {
  model: string;
  contents: ContentListUnion;
  config?: GenerateContentConfig;
  apiKey?: string;
  retryProfile?: LlmRetryProfile;
  attempts?: number;
}): Promise<{ text?: string; candidates?: Candidate[] }> {
  throw new LlmProviderError({
    provider: 'gemini',
    code: 'GEMINI_DISABLED',
    reason: 'Gemini video labels are disabled in Ad Lab',
    remediation: 'Video ads are labelled from their poster image.',
    retryable: false,
    status: 501,
  });
}

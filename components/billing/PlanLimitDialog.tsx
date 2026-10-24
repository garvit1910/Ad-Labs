'use client';

/** Ad Lab same-path stub (REUSE_MANIFEST §8.2): no billing, so no plan-limit dialog. */
import type { ReactNode } from 'react';
import type { LimitedFeature } from '@/lib/billing/plans';

export function usePlanLimitPrompt(_defaults: { feature?: LimitedFeature } = {}): {
  handleBillingError: (_error: unknown, _options?: unknown) => boolean;
  dialog: ReactNode;
} {
  return { handleBillingError: () => false, dialog: null };
}

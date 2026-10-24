/** Ad Lab same-path stub (REUSE_MANIFEST §8.2): no canned example overview. */
import type { BrandSynthesis } from '@/lib/brand-object/synthesis/types';

export const EXAMPLE_BRAND_SYNTHESIS: BrandSynthesis | null = null;

export function shouldShowExampleAiOverview(
  _organizationId?: string | null,
  _organizationName?: string | null,
): boolean {
  return false;
}

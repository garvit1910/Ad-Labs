import { cn } from '@/lib/utils';

/**
 * The section's responsive ad-card grid recipe, in three intentional
 * densities. One definition so column breakpoints can't drift per page:
 * - `wide`: full-width browse surfaces (library, industry "view all")
 * - `medium`: detail/secondary surfaces (competitor detail, leaderboards,
 *   collections)
 * - `compact`: constrained containers (dialogs, panels that stop at lg)
 */
const AD_GRID_DENSITIES = {
  wide: 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6',
  medium: 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
  compact: 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4',
} as const;

export type AdGridDensity = keyof typeof AD_GRID_DENSITIES;

/** Class string for an ad-card grid at the given density. */
export function adGridClass(
  density: AdGridDensity = 'wide',
  className?: string
): string {
  return cn(AD_GRID_DENSITIES[density], className);
}

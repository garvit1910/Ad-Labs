/**
 * Normalize a freeform visual-style string to the closed `VISUAL_STYLES` enum.
 *
 * The creative-engine genome's `style` dimension and the competitor
 * ad-intelligence `ad_labels.style` dimension are BOTH keyed on the same
 * taxonomy name (`style`) in `performance_memory` — but historically the
 * genome side carried freeform prose ("clean, product-forward, offer-led")
 * while the label side already used the enum. This mapper closes that gap so
 * own-ad style performance and competitor style intel finally share values.
 *
 * One deterministic mapper, two consumers: the brief composer (at genome-stamp
 * time) and the genome backfill script. Import the enum from the ad-library
 * taxonomy — the single source of truth for `VISUAL_STYLES` (the same
 * cross-boundary direction as `lib/brand-identity/industry-taxonomy.ts`).
 */

import { VISUAL_STYLES, type VisualStyle } from '@/services/ad-library/label-taxonomy';

const ENUM_SET = new Set<string>(VISUAL_STYLES);

/**
 * Map a freeform style string (or an already-enum value) to a `VisualStyle`.
 * Rules are applied in order on the case-insensitive, trimmed input:
 * exact enum member wins, then a substring-keyword ladder, else `'other'`.
 * The keyword ladder is authored so the four `GOAL_STRATEGIES` blueprint
 * strings land on their locked targets (see brief-composer.ts).
 */
export function normalizeVisualStyle(input: string | null | undefined): VisualStyle {
  const trimmed = (input ?? '').trim();
  if (trimmed.length === 0) return 'other';

  const lower = trimmed.toLowerCase();

  // 1. Exact enum member (case-insensitive) passes through — idempotent.
  if (ENUM_SET.has(lower)) return lower as VisualStyle;

  const has = (...needles: string[]): boolean =>
    needles.some((needle) => lower.includes(needle));

  // 2. Creator / casual / authentic → lo_fi_ugc.
  if (has('ugc', 'lo-fi', 'lofi', 'authentic', 'casual', 'personality')) return 'lo_fi_ugc';

  // 3. Studio / polished product photography → polished_studio.
  if (has('studio', 'polished', 'clean', 'product-forward', 'lifestyle', 'photograph'))
    return 'polished_studio';

  // 4. Screen recording / app walkthrough → screen_capture.
  if (has('screen', 'app ui', 'walkthrough')) return 'screen_capture';

  // 5. Filmic / produced video → cinematic.
  if (has('cinematic', 'filmic', 'film')) return 'cinematic';

  // 6. Meme composition → meme_style.
  if (has('meme')) return 'meme_style';

  // 7. Flat / composed / graphic / editorial → designed_graphic.
  if (
    has(
      'graphic',
      'flat',
      'design',
      'illustration',
      'minimal',
      'editorial',
      'iconic',
      'brand-saturated',
      'high-contrast',
      'crisp'
    )
  )
    return 'designed_graphic';

  return 'other';
}

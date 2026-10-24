import type { MentionPlatform } from '@/lib/brand-presence/types';

/**
 * Display name per mention platform — PURE and server-safe, so the screen's
 * channel map (`components/brand-presence/channel-style.tsx`), the Brand Book
 * and the headless report PDF all print a platform the same way.
 */
export const MENTION_PLATFORM_LABELS: Record<MentionPlatform, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  reddit: 'Reddit',
  amazon: 'Amazon',
  google_maps: 'Google Maps',
  x: 'X',
  trustpilot: 'Trustpilot',
};

/** Platform-only display name, falling back to the raw value. */
export function mentionPlatformLabel(platform: string): string {
  return MENTION_PLATFORM_LABELS[platform as MentionPlatform] ?? platform;
}

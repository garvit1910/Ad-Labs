'use client';

import {
  Instagram,
  MapPin,
  MessageCircle,
  Music2,
  ShoppingBag,
  Star,
  Twitter,
  type LucideIcon,
} from 'lucide-react';
import type { MentionPlatform } from '@/lib/brand-presence/types';
import {
  MENTION_PLATFORM_LABELS,
  mentionPlatformLabel,
} from '@/lib/brand-presence/platform-labels';
import { cn } from '@/lib/utils';

/**
 * The mention-channel identity system: one badge colour + glyph + label per
 * `MentionPlatform`. This is the shared map that did not previously exist —
 * `SOURCE_REGISTRY` is keyed by `source_type` (and renders logos on white
 * tiles), whereas the mention feeds carry a loose `platform` string. Both the
 * theme drawer (`ThemeMentionsSheet`) and "Loudest voices"
 * (`PulseTopCommentsPanel`) resolve channel identity through here.
 */
export interface ChannelStyle {
  /** Platform display name, e.g. "TikTok". */
  label: string;
  /** Brand accent for tints, quote borders, and dots. Reads on light + dark. */
  accent: string;
  /**
   * Badge fill. Usually the accent, but near-black brands (TikTok, X) keep
   * their true dark identity here while `accent` carries the colour used for
   * tints/borders. May be a CSS gradient (Instagram). A white glyph rides on
   * top, so any value here must stay dark/saturated enough for white.
   */
  badge: string;
  Icon: LucideIcon;
}

/** Exact over `MentionPlatform` — TS keeps this in step with the closed set. */
export const CHANNEL_STYLE: Record<MentionPlatform, ChannelStyle> = {
  tiktok: { label: MENTION_PLATFORM_LABELS.tiktok, accent: '#FE2C55', badge: '#000000', Icon: Music2 },
  instagram: {
    label: MENTION_PLATFORM_LABELS.instagram,
    accent: '#D62976',
    badge:
      'linear-gradient(48deg, #feda75, #fa7e1e 28%, #d62976 60%, #962fbf 82%, #4f5bd5)',
    Icon: Instagram,
  },
  reddit: { label: MENTION_PLATFORM_LABELS.reddit, accent: '#FF4500', badge: '#FF4500', Icon: MessageCircle },
  amazon: { label: MENTION_PLATFORM_LABELS.amazon, accent: '#FF9900', badge: '#232F3E', Icon: ShoppingBag },
  google_maps: { label: MENTION_PLATFORM_LABELS.google_maps, accent: '#34A853', badge: '#34A853', Icon: MapPin },
  x: { label: MENTION_PLATFORM_LABELS.x, accent: '#71767B', badge: '#0F0F0F', Icon: Twitter },
  trustpilot: { label: MENTION_PLATFORM_LABELS.trustpilot, accent: '#00B67A', badge: '#00B67A', Icon: Star },
};

/** Neutral fallback for any platform outside the closed set (loose `string`). */
const FALLBACK_STYLE: ChannelStyle = {
  label: 'Mention',
  accent: '#7c5cff',
  badge: '#7c5cff',
  Icon: MessageCircle,
};

export function resolveChannelStyle(platform: string): ChannelStyle {
  return CHANNEL_STYLE[platform as MentionPlatform] ?? FALLBACK_STYLE;
}

/** Platform-only display name, falling back to the raw value. */
export function channelLabel(platform: string): string {
  return mentionPlatformLabel(platform);
}

/**
 * The channel accent as an `rgba()` string at `alpha` (0–1). Composites over
 * both light and dark cards, so it beats theme-var `color-mix` for tints and
 * borders. Non-hex accents fall back to the raw value at full opacity.
 */
export function channelAccentAlpha(platform: string, alpha: number): string {
  const accent = resolveChannelStyle(platform).accent;
  const hex = accent.replace('#', '');
  if (hex.length !== 6) return accent;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The brand-coloured channel badge: white glyph on the platform's identity
 * colour. `size` is the outer diameter in px; the glyph scales with it.
 */
export function ChannelBadge({
  platform,
  size = 20,
  className,
}: {
  platform: string;
  size?: number;
  className?: string;
}) {
  const style = resolveChannelStyle(platform);
  const Icon = style.Icon;
  return (
    <span
      className={cn(
        'inline-grid flex-none place-items-center rounded-full text-white ring-1 ring-inset ring-white/20',
        className,
      )}
      style={{ width: size, height: size, background: style.badge }}
      aria-hidden="true"
    >
      <Icon size={Math.round(size * 0.58)} strokeWidth={2.25} />
    </span>
  );
}

import type { LucideIcon } from 'lucide-react';
import {
  Instagram,
  MapPin,
  MessageCircle,
  MessagesSquare,
  Music2,
  Newspaper,
  Search,
  ShoppingBag,
  Star,
  Twitter,
  Youtube,
} from 'lucide-react';
import type { BrandPresenceSourceType } from './types';

export interface SourceRegistryEntry {
  label: string;
  description: string;
  /** Fallback glyph when no logo image exists for the platform. */
  icon: LucideIcon;
  /** Real platform logo under public/ (rendered in a white logo tile). */
  logoSrc?: string;
  availability: 'live' | 'coming_soon';
}

/**
 * Drives the Brand Presence source card grid AND which source types the
 * pipeline may scrape. Adding a future source = build its adapter + flip its
 * entry to 'live' (+ seed rows already exist as coming_soon) — the page
 * renders from this map with zero rework.
 */
export const SOURCE_REGISTRY: Record<
  BrandPresenceSourceType,
  SourceRegistryEntry
> = {
  reddit_search: {
    label: 'Reddit — brand mentions',
    description: 'Every Reddit post and comment that names your brand.',
    icon: MessageCircle,
    logoSrc: '/images/logos/brand-presence/reddit.png',
    availability: 'live',
  },
  reddit_subreddit: {
    label: 'Reddit — community',
    description:
      'Brand, competitor, and buying-intent discussion inside a community.',
    icon: MessagesSquare,
    logoSrc: '/images/logos/brand-presence/reddit.png',
    availability: 'live',
  },
  reddit_category: {
    label: 'Reddit — category listening',
    description:
      'Competitor reviews and "best of" threads across your category.',
    icon: Search,
    logoSrc: '/images/logos/brand-presence/reddit.png',
    availability: 'live',
  },
  amazon_reviews: {
    label: 'Amazon Reviews',
    description: 'Verified purchase reviews for your products.',
    icon: ShoppingBag,
    logoSrc: '/images/logos/brand-presence/amazon.png',
    availability: 'live',
  },
  google_maps_reviews: {
    label: 'Google Maps reviews',
    description: 'Star ratings and reviews on your Google Maps listing.',
    icon: MapPin,
    logoSrc: '/images/logos/brand-presence/google.png',
    availability: 'live',
  },
  instagram_comments: {
    label: 'Instagram comments',
    description: 'What followers say under your own posts and reels.',
    icon: Instagram,
    logoSrc: '/images/logos/brand-presence/instagram.png',
    availability: 'live',
  },
  tiktok_comments: {
    label: 'TikTok comments',
    description: 'What viewers say under your own videos.',
    icon: Music2,
    logoSrc: '/images/logos/brand-presence/tiktok.jpg',
    availability: 'live',
  },
  trustpilot: {
    label: 'Trustpilot',
    description: 'Your Trustpilot review stream.',
    icon: Star,
    logoSrc: '/images/logos/brand-presence/trustpilot.png',
    availability: 'live',
  },
  onsite_reviews: {
    label: 'On-site reviews',
    description: "Reviews collected on your own store.",
    icon: Newspaper,
    availability: 'coming_soon',
  },
  youtube: {
    label: 'YouTube',
    description: 'Mentions and reviews in videos and comments.',
    icon: Youtube,
    logoSrc: '/images/logos/brand-presence/youtube.png',
    availability: 'coming_soon',
  },
  x: {
    label: 'X (Twitter)',
    description: 'Posts and replies mentioning your brand.',
    icon: Twitter,
    logoSrc: '/images/logos/brand-presence/x.png',
    availability: 'live',
  },
};


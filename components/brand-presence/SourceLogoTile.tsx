'use client';

import Image from 'next/image';
import { SOURCE_REGISTRY } from '@/lib/brand-presence/source-registry';
import type { BrandPresenceSourceType } from '@/lib/brand-presence/types';
import { cn } from '@/lib/utils';
import { useSourceTypeCopy } from './presence-copy';

const TILE_SIZES = {
  /** 36px card tile (Attribution Integrations standard). */
  md: { tile: 'h-9 w-9', image: 24 },
  /** 28px row tile. */
  sm: { tile: 'h-7 w-7', image: 18 },
} as const;

/**
 * The white logo cell from the Attribution Integrations standard (brand-book
 * §12): real platform logo on a white tile with a hairline border; falls
 * back to the registry's lucide glyph when no logo asset exists (e.g.
 * onsite_reviews).
 */
export function SourceLogoTile({
  sourceType,
  size = 'md',
  muted = false,
  className,
}: {
  sourceType: BrandPresenceSourceType;
  size?: keyof typeof TILE_SIZES;
  /** Grey out for coming-soon sources. */
  muted?: boolean;
  className?: string;
}) {
  const sourceCopy = useSourceTypeCopy();
  const entry = SOURCE_REGISTRY[sourceType];
  if (!entry) return null;
  const Icon = entry.icon;
  const { tile, image } = TILE_SIZES[size];
  return (
    <span
      className={cn(
        'flex flex-none items-center justify-center rounded-lg border border-border bg-white/90 shadow-sm',
        tile,
        muted && 'opacity-70 saturate-50',
        className,
      )}
    >
      {entry.logoSrc ? (
        <Image
          src={entry.logoSrc}
          alt={sourceCopy.label(sourceType)}
          width={image}
          height={image}
          className="rounded-[4px] object-contain"
        />
      ) : (
        <Icon className="h-4.5 w-4.5 text-brand-text" />
      )}
    </span>
  );
}

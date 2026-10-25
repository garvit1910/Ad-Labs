'use client';

import Link from 'next/link';
import { Database, ImagePlus } from 'lucide-react';
import { ago, tsMs } from '../_lib/selectors';

/** The brand_kit row's fields this strip reads (lib/spacetime/bindings, camelCased). */
export interface BrandKitRowLike {
  brandUrl: string;
  brandName: string;
  imageFile: string;
  updatedAt: { microsSinceUnixEpoch: bigint };
}

/**
 * The brand kit as the agents see it: the one brand_kit row in SpacetimeDB, the same state Ad Lab
 * checks before a run and the Copywriter renders the winning ads from. Missing: a link to /start.
 */
export function BrandKitStrip({ kit, now }: { kit: BrandKitRowLike | null; now: number }) {
  if (!kit) {
    return (
      <Link
        href="/start"
        className="flex items-center gap-3 rounded-xl border border-status-warning/30 bg-status-warning-soft px-4 py-3 text-sm text-status-warning"
      >
        <ImagePlus className="size-4 shrink-0" />
        No brand kit in SpacetimeDB yet: Ad Lab will ask for it before any run. Set the brand URL and product photo →
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/brand-kit/image/${kit.imageFile}`} alt="Product reference photo" className="size-12 rounded-md border border-border/60 object-contain" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{kit.brandName || kit.brandUrl}</span>
        <span className="truncate text-xs text-muted-foreground">{kit.brandUrl} · product reference photo</span>
      </div>
      <span className="hidden items-center gap-1.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">
        <Database className="size-3.5" />
        brand_kit · updated {ago(tsMs(kit.updatedAt), now)}
      </span>
      <Link href="/start" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        Change
      </Link>
    </div>
  );
}

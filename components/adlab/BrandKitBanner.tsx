'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight, ImagePlus } from 'lucide-react';

/**
 * Shown on every section until the brand kit is saved: the kit is the first step after the landing
 * page. A banner, never a redirect, so /sim replays keep working without one. Hidden on /start.
 */
export function BrandKitBanner() {
  const pathname = usePathname() ?? '/';
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/agent/brand-kit', { cache: 'no-store' })
      .then((res) => res.json())
      .then((body: { ok: boolean; data?: { ready: boolean } }) => live && setMissing(body.ok && body.data?.ready === false))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pathname]);

  if (!missing || pathname.startsWith('/start')) return null;
  return (
    <Link
      href="/start"
      className="flex items-center gap-3 rounded-lg border border-brand/40 bg-brand-soft px-4 py-2.5 text-sm text-brand-text hover:border-brand/70"
    >
      <ImagePlus className="size-4 shrink-0" />
      <span className="flex-1">Start with your brand kit: the brand URL and a product photo. The agents won&apos;t start a run without it.</span>
      <ArrowRight className="size-4 shrink-0" />
    </Link>
  );
}

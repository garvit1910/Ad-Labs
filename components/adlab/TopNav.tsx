'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Bot, Fingerprint, FlaskConical, ImagePlus, Swords, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// The brand kit comes first: it's the step right after the landing page, before any other.
const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/start', label: 'Brand kit', icon: ImagePlus },
  { href: '/brand-identity', label: 'Brand Identity', icon: Fingerprint },
  { href: '/brand-identity/competitor-analysis', label: 'Competitor Analysis', icon: Swords },
  { href: '/sim', label: 'Live sim', icon: Activity },
  { href: '/agents', label: 'Agents', icon: Bot },
];

// Longest href first, so /brand-identity/competitor-analysis wins over /brand-identity.
const BY_SPECIFICITY = [...NAV].sort((a, b) => b.href.length - a.href.length);

function activeHref(pathname: string): string | null {
  return BY_SPECIFICITY.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.href ?? null;
}

/** Ad Lab's app shell nav: home, the brand kit, then the four sections, the current one highlighted. */
export function TopNav() {
  const active = activeHref(usePathname() ?? '/');
  return (
    <nav className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-4">
      <Link href="/" className="mr-2 flex items-center gap-2 text-sm font-semibold">
        <FlaskConical className="size-4 text-brand-text" />
        Ad Lab
      </Link>
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={active === href ? 'page' : undefined}
          className={cn(
            'glass-pill flex items-center gap-1.5 px-3 py-1 text-xs',
            active === href ? 'text-brand-text' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </Link>
      ))}
    </nav>
  );
}

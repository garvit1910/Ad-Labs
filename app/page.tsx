import Link from 'next/link';
import { Activity, Bot, Fingerprint, FlaskConical, Swords, type LucideIcon } from 'lucide-react';
import { EyebrowChip } from '@/components/ui/eyebrow-chip';
import { PageHeader } from '@/components/ui/page-header';

const SECTIONS: { href: string; title: string; description: string; icon: LucideIcon }[] = [
  {
    href: '/brand-identity',
    title: 'Brand Identity',
    description: "Magic Spoon's positioning, proof points and customer voice, distilled from real reviews and posts.",
    icon: Fingerprint,
  },
  {
    href: '/brand-identity/competitor-analysis',
    title: 'Competitor Analysis',
    description: "The competitors' live Meta ads, labelled by angle and hook, and the ones that keep running.",
    icon: Swords,
  },
  {
    href: '/sim',
    title: 'Live sim',
    description: 'Ad recipes tested on Jev-driven shoppers, round by round.',
    icon: Activity,
  },
  {
    href: '/agents',
    title: 'Agents',
    description: 'Ad Lab, Scout, Strategist and Copywriter at work: every message, status and Apify job, live from SpacetimeDB.',
    icon: Bot,
  },
];

export default function Home() {
  return (
    <>
      <PageHeader
        eyebrow={<EyebrowChip icon={FlaskConical}>Cal Hacks 13.0</EyebrowChip>}
        title="Ad Lab"
        description="Magic Spoon ad recipes, tested on simulated shoppers built from real customer voice."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {SECTIONS.map(({ href, title, description, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="frost-card flex flex-col gap-3 p-5 transition-colors hover:border-brand/40"
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-brand-soft text-brand-text">
              <Icon className="size-4" />
            </span>
            <span className="text-lg font-semibold tracking-tight">{title}</span>
            <span className="text-sm text-muted-foreground">{description}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

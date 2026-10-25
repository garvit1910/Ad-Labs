import Link from 'next/link';
import { Martian_Mono } from 'next/font/google';
import { Activity, ArrowUpRight, Bot, Fingerprint, FlaskConical, Swords, type LucideIcon } from 'lucide-react';
import ParticleField from '@/components/ParticleField';
import './landing.css';

// The wordmark's face. Loaded here rather than in lib/fonts-online.ts so only the
// landing page downloads it.
const martian = Martian_Mono({ variable: '--font-martian', weight: '800', subsets: ['latin'], display: 'swap' });

const SECTIONS: { href: string; title: string; description: string; icon: LucideIcon }[] = [
  {
    href: '/brand-identity',
    title: 'Brand Identity',
    description: 'Positioning, proof points and customer voice, distilled from real reviews and posts.',
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

function Frame() {
  return (
    <div className="bgframe" aria-hidden="true">
      <i className="tl" /><i className="tr" /><i className="bl" /><i className="br" />
    </div>
  );
}

// The front door: the constellation background (app/landing-bg.css) with the hero and the
// section cards on top. Every page behind it renders inside AppShell instead.
export default function Home() {
  return (
    <main className={`lh ${martian.variable}`}>
      <div className="bgwrap">
        <ParticleField />

        <section className="bgscreen">
          <div className="bgscrim" aria-hidden="true" />
          <Frame />
          <div className="bgbody">
            <span className="lh-eyebrow">
              <FlaskConical className="size-3.5" />
              Cal Hacks 13.0
            </span>
            <h1 className="lh-mark">Ad Lab</h1>
            <p className="lh-sub">Ad recipes, tested on simulated shoppers built from real customer voice.</p>
            <div className="lh-cards">
              {SECTIONS.map(({ href, title, description, icon: Icon }) => (
                <Link key={href} href={href} className="lh-card">
                  <span className="lh-icon">
                    <Icon className="size-4" />
                  </span>
                  <ArrowUpRight className="lh-arrow size-4" aria-hidden="true" />
                  <span className="lh-title">{title}</span>
                  <span className="lh-desc">{description}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

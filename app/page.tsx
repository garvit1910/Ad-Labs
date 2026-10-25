import Link from 'next/link';
import { Martian_Mono } from 'next/font/google';
import { Activity, ArrowRight, ArrowUpRight, Bot, Fingerprint, FlaskConical, ImagePlus, type LucideIcon } from 'lucide-react';
import ParticleField from '@/components/ParticleField';
import './landing.css';

// The wordmark's face. Loaded here rather than in lib/fonts-online.ts so only the
// landing page downloads it.
const martian = Martian_Mono({ variable: '--font-martian', weight: '800', subsets: ['latin'], display: 'swap' });

// The path through Ad Lab, in order. Step 1, the brand kit (/start), comes before anything else,
// so it is the only step that links from here; /start opens the rest once the kit is saved.
const STEPS: { href?: string; title: string; description: string; icon: LucideIcon }[] = [
  {
    href: '/start',
    title: 'Brand kit',
    description: "Your brand's website and a product photo: the agents start from it, and every ad image is rendered with the real product.",
    icon: ImagePlus,
  },
  {
    title: 'Agents',
    description: 'Ad Lab, Scout, Strategist and Copywriter at work: every message, status and Apify job, live from SpacetimeDB.',
    icon: Bot,
  },
  {
    title: 'Live sim',
    description: 'Ad recipes tested on Jev-driven shoppers, round by round.',
    icon: Activity,
  },
  {
    title: 'Brand & competitors',
    description: 'Positioning, customer voice and the competitors\' live Meta ads, distilled from real data.',
    icon: Fingerprint,
  },
];

function Frame() {
  return (
    <div className="bgframe" aria-hidden="true">
      <i className="tl" /><i className="tr" /><i className="bl" /><i className="br" />
    </div>
  );
}

// The front door: the constellation background (app/landing-bg.css) with the hero, the Get
// started button and the steps on top. Every page behind it renders inside AppShell instead.
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
            <Link href="/start" className="lh-cta">
              Get started
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <ol className="lh-cards">
              {STEPS.map(({ href, title, description, icon: Icon }, i) => {
                const body = (
                  <>
                    <span className="lh-icon">
                      <Icon className="size-4" />
                    </span>
                    {href && <ArrowUpRight className="lh-arrow size-4" aria-hidden="true" />}
                    <span className="lh-step">Step {i + 1}</span>
                    <span className="lh-title">{title}</span>
                    <span className="lh-desc">{description}</span>
                  </>
                );
                return (
                  <li key={title} className="contents">
                    {href ? (
                      <Link href={href} className="lh-card">
                        {body}
                      </Link>
                    ) : (
                      <div className="lh-card is-later">{body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </section>
      </div>
    </main>
  );
}

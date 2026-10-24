import {
  Bookmark,
  Ear,
  Fingerprint,
  FolderArchive,
  LandPlot,
  LayoutDashboard,
  Lightbulb,
  Swords,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Messages } from 'next-intl';

/** Leaf of `BrandIdentity.nav` - the rendered (translated) tab label. */
export type BrandIdentityNavLabelKey = keyof Messages['BrandIdentity']['nav'];

export interface BrandIdentityNavTab<V extends string> {
  value: V;
  /** English label (fallback + the label tests and route guards match on). */
  label: string;
  /** `BrandIdentity.nav` key the UI renders. */
  labelKey: BrandIdentityNavLabelKey;
  href: string;
  icon: LucideIcon;
}

// ── Top level: the three section tabs ───────────────────────────────────────
export type BrandIdentitySectionValue = 'brand' | 'competitor-analysis' | 'presence';

/**
 * The Brand Identity section's top-level tab bar (rendered once in
 * `layout.tsx`). Each tab is a real route - switching tabs is a client
 * navigation. The section root IS the Brand Identity (the Layer-3 Brand
 * Object report); Competitor Analysis (L1) and Brand Presence (L2) are its
 * sub-tabs. The order here is the display order.
 */
export const BRAND_IDENTITY_SECTIONS: BrandIdentityNavTab<BrandIdentitySectionValue>[] = [
  {
    value: 'brand',
    label: 'Brand Identity',
    labelKey: 'brandIdentity',
    href: '/brand-identity',
    icon: Fingerprint,
  },
  {
    value: 'competitor-analysis',
    label: 'Competitor Analysis',
    labelKey: 'competitorAnalysis',
    href: '/brand-identity/competitor-analysis',
    icon: Swords,
  },
  {
    value: 'presence',
    label: 'Brand Presence',
    labelKey: 'brandPresence',
    href: '/brand-identity/presence',
    icon: Ear,
  },
];

/**
 * The nav's hierarchy split: Brand Identity is the DESTINATION (the report);
 * Competitor Analysis and Brand Presence are its numbered SOURCES - inputs
 * the report distills, set up in this order by the guided wizard. Same
 * routes/values as BRAND_IDENTITY_SECTIONS; this is display metadata only.
 */
export const BRAND_IDENTITY_SOURCE_SECTIONS: Array<
  BrandIdentityNavTab<BrandIdentitySectionValue> & { number: string }
> = [
  { ...BRAND_IDENTITY_SECTIONS[1], number: '01' },
  { ...BRAND_IDENTITY_SECTIONS[2], number: '02' },
];

/** `BrandIdentity.headers` sub-object holding a section's title + description. */
export type BrandIdentityHeaderKey = keyof Messages['BrandIdentity']['headers'];

/**
 * Per-section header copy - the layout owns the single `PageHeader`. The
 * English strings stay beside the catalog key (`headerKey`) the layout renders.
 */
export const BRAND_IDENTITY_SECTION_HEADERS: Record<
  BrandIdentitySectionValue,
  { title: string; description: string; headerKey: BrandIdentityHeaderKey }
> = {
  brand: {
    title: 'Brand Identity',
    description:
      'Your evidence-backed brand report - what you claim, what customers say, and what your market rewards, distilled from every layer.',
    headerKey: 'brand',
  },
  'competitor-analysis': {
    title: 'Competitor Analysis',
    description:
      'Competitor ad intelligence - what they run, what they scale, what survives.',
    headerKey: 'competitorAnalysis',
  },
  presence: {
    title: 'Brand Presence',
    description:
      'What the internet says about your brand - collected, filtered, and distilled into your Brand Identity.',
    headerKey: 'presence',
  },
};

// ── Second level: the Competitor Analysis family ────────────────────────────
// The competitors/library/collections URLs are unchanged (deep links + query
// filters survive); they are grouped under Competitor Analysis in nav only.
export type CompetitorAnalysisTabValue =
  | 'overview'
  | 'playbook'
  | 'map'
  | 'competitors'
  | 'library'
  | 'collections';

export const COMPETITOR_ANALYSIS_TABS: BrandIdentityNavTab<CompetitorAnalysisTabValue>[] = [
  {
    value: 'overview',
    label: 'Overview',
    labelKey: 'overview',
    href: '/brand-identity/competitor-analysis',
    icon: LayoutDashboard,
  },
  {
    value: 'playbook',
    label: 'Playbook',
    labelKey: 'playbook',
    href: '/brand-identity/playbook',
    icon: Lightbulb,
  },
  {
    value: 'map',
    label: 'Map',
    labelKey: 'map',
    href: '/brand-identity/map',
    icon: LandPlot,
  },
  {
    value: 'competitors',
    label: 'Competitors',
    labelKey: 'competitors',
    href: '/brand-identity/competitors',
    icon: Users,
  },
  {
    value: 'library',
    label: 'Ad Library',
    labelKey: 'adLibrary',
    href: '/brand-identity/library',
    icon: FolderArchive,
  },
  {
    value: 'collections',
    label: 'Collections',
    labelKey: 'collections',
    href: '/brand-identity/collections',
    icon: Bookmark,
  },
];

/**
 * The Competitor Analysis sub-tabs an org may see, gated on the redesign
 * pre-release allowlist (see `lib/brand-identity/competitor-redesign-access.ts`).
 *
 * - `redesignEnabled === false` → today's exact non-gated experience: the public
 *   tabs only (no Playbook, no Map), landing tab labeled 'Overview'.
 * - `redesignEnabled === true` → the full family, with the landing tab relabeled
 *   'Today' (same 'overview' value + href - the landing URL never changes).
 *
 * Only the labels differ; values/hrefs/order are the canonical
 * `COMPETITOR_ANALYSIS_TABS`, so the resolvers and deep links stay stable.
 */
export function competitorAnalysisTabsForOrg(
  redesignEnabled: boolean,
): BrandIdentityNavTab<CompetitorAnalysisTabValue>[] {
  if (!redesignEnabled) {
    return COMPETITOR_ANALYSIS_TABS.filter(
      (tab) => tab.value !== 'playbook' && tab.value !== 'map',
    );
  }
  return COMPETITOR_ANALYSIS_TABS.map((tab) =>
    tab.value === 'overview' ? { ...tab, label: 'Today', labelKey: 'today' } : tab,
  );
}

/**
 * Where an org off the report allowlist lands instead of the report side (the
 * section root + the setup wizard) - see `lib/brand-object/brand-report-access.ts`.
 */
export const BRAND_REPORT_FALLBACK_HREF = '/brand-identity/competitor-analysis';

/** Header copy for the guided setup wizard (`/brand-identity/setup`). */
export const BRAND_IDENTITY_SETUP_HEADER: {
  title: string;
  description: string;
  headerKey: BrandIdentityHeaderKey;
} = {
  title: 'Set up a new brand',
  description:
    'Your website, the competitors worth watching, your brand profile, and where customers talk - then we build your brand report.',
  headerKey: 'setup',
};

// ── Resolvers ────────────────────────────────────────────────────────────────

/**
 * The guided setup wizard owns its own progress chrome, so the layout renders
 * it with the setup header and NO tab rows (a wizard shouldn't offer sibling
 * navigation; it exits via its own links).
 */
export function isSetupPath(pathname: string): boolean {
  return (
    pathname === '/brand-identity/setup' ||
    pathname.startsWith('/brand-identity/setup/')
  );
}

/**
 * The competitor drill-in (`/brand-identity/competitors/<id>`) owns its own
 * header + shell (back button, sync), so the layout renders it bare - no tab
 * bar. The bare list route (`/brand-identity/competitors`) is NOT a detail path.
 */
export function isCompetitorDetailPath(pathname: string): boolean {
  return /^\/brand-identity\/competitors\/.+/.test(pathname);
}

/** Every path in the Competitor Analysis family (drives the second tab row). */
export function isCompetitorAnalysisPath(pathname: string): boolean {
  return (
    pathname.startsWith('/brand-identity/competitor-analysis') ||
    pathname.startsWith('/brand-identity/playbook') ||
    pathname.startsWith('/brand-identity/map') ||
    pathname.startsWith('/brand-identity/competitors') ||
    pathname.startsWith('/brand-identity/library') ||
    pathname.startsWith('/brand-identity/collections')
  );
}

/**
 * Top-level section for a pathname. `/brand-identity/brand` (the redirect
 * stub) falls through to 'brand' so the redirect never flashes a wrong tab.
 */
export function resolveBrandIdentitySection(
  pathname: string,
): BrandIdentitySectionValue {
  if (pathname.startsWith('/brand-identity/presence')) return 'presence';
  if (isCompetitorAnalysisPath(pathname)) return 'competitor-analysis';
  return 'brand';
}

/**
 * Active Competitor Analysis sub-tab (meaningful only when
 * `isCompetitorAnalysisPath`). Note `/brand-identity/competitor-analysis` does
 * NOT startWith `/brand-identity/competitors` ('competitor-a' ≠ 'competitors'),
 * so the overview correctly falls through - locked by navigation.test.ts.
 */
export function resolveCompetitorAnalysisTab(
  pathname: string,
): CompetitorAnalysisTabValue {
  if (pathname.startsWith('/brand-identity/playbook')) return 'playbook';
  // '/brand-identity/map' has no prefix collisions - resolve before 'competitors'.
  if (pathname.startsWith('/brand-identity/map')) return 'map';
  if (pathname.startsWith('/brand-identity/library')) return 'library';
  if (pathname.startsWith('/brand-identity/collections')) return 'collections';
  if (pathname.startsWith('/brand-identity/competitors')) return 'competitors';
  return 'overview';
}

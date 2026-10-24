import { z } from 'zod';

/**
 * Industry Explorer config — the single source of truth for the global,
 * pre-populated "browse ads by industry" catalog on the Brand Identity page.
 *
 * Unlike competitor tracking (per-org, added by the user), industries are a
 * SHARED catalog identical for every org and viewable before any competitor
 * exists. They are modelled as global "catalog" pseudo-competitors owned by a
 * single fixed system organization (`INDUSTRY_CATALOG_ORG_ID`) and marked by
 * `tracked_competitors.industry`, so the entire existing sync → label → embed →
 * win-score pipeline is reused unchanged. See `lib/brand-identity/CLAUDE.md`.
 *
 * This module is import-safe on the client (pure data + zod) — the Industry
 * filter UI reads `label`/`emoji` from here. `INDUSTRY_CATALOG_ORG_ID` is not a
 * secret; it is a well-known sentinel org id.
 */

/** Catalog owner org for every industry pseudo-competitor (fixed sentinel UUID). */
export const INDUSTRY_CATALOG_ORG_ID = 'ad000000-0000-4000-a000-000000000001';

/**
 * Ads to cache per industry seed per sync. Caps the Apify run for catalog seeds
 * only (the sync processor passes this just when the competitor is owned by
 * `INDUSTRY_CATALOG_ORG_ID` — NOT when `tracked_competitors.industry` is set,
 * since user-tracked competitors carry an industry classification too); real
 * competitors keep their own default ceiling. The actor stops at
 * the keyword's real ad count, so narrow keywords can return fewer.
 */
export const INDUSTRY_ADS_PER_SYNC = 100;

export interface IndustryDefinition {
  /** Stable machine key (snake/kebab); used in URLs, the DB `industry` column, and the Zod enum. */
  readonly key: string;
  /** Human label shown in the filter (matches the Figma). */
  readonly label: string;
  /** Emoji prefix shown in the filter (matches the Figma). */
  readonly emoji: string;
  /**
   * Meta Ad Library keyword search term(s). One Meta catalog pseudo-competitor
   * is seeded per keyword. Start with one strong, high-intent term; add more if
   * a single keyword surfaces a noisy corpus (each extra keyword is another
   * Apify run on every refresh). Tuned against real output during verification.
   */
  readonly metaKeywords: readonly string[];
  /**
   * Google Ads Transparency Center advertiser AR ids (Google has no keyword
   * search). One Google catalog pseudo-competitor is seeded per id. Populated
   * in Phase 3a by looking up well-known brands per industry. Empty = Google
   * not yet seeded for this industry (Meta still works).
   */
  readonly googleAdvertiserIds: readonly string[];
}

/** Order matches the Figma dropdown. */
export const INDUSTRIES: readonly IndustryDefinition[] = [
  { key: 'accessories', label: 'Accessories', emoji: '👜', metaKeywords: ['accessories'], googleAdvertiserIds: [] },
  // Tesla (AR17828074650563772417) is a live-verified Google AR id. The rest of
  // the curated 5–10 advertisers/industry are a documented fast-follow — resolve
  // each from its Transparency Center URL (adstransparency.google.com/advertiser/AR…).
  { key: 'automotive', label: 'Automotive', emoji: '🚗', metaKeywords: ['car accessories'], googleAdvertiserIds: ['AR17828074650563772417'] },
  { key: 'beauty', label: 'Beauty', emoji: '💄', metaKeywords: ['skincare'], googleAdvertiserIds: [] },
  { key: 'jewelry', label: 'Jewelry', emoji: '💎', metaKeywords: ['jewelry'], googleAdvertiserIds: [] },
  { key: 'shoes', label: 'Shoes', emoji: '👠', metaKeywords: ['sneakers'], googleAdvertiserIds: [] },
  { key: 'clothing', label: 'Clothing', emoji: '👕', metaKeywords: ['apparel'], googleAdvertiserIds: [] },
  { key: 'electronics', label: 'Electronics', emoji: '📱', metaKeywords: ['electronics'], googleAdvertiserIds: [] },
  { key: 'sport', label: 'Sport', emoji: '🏀', metaKeywords: ['fitness gear'], googleAdvertiserIds: [] },
  { key: 'food', label: 'Food', emoji: '🍔', metaKeywords: ['snacks'], googleAdvertiserIds: [] },
  { key: 'gaming', label: 'Gaming', emoji: '🎮', metaKeywords: ['gaming'], googleAdvertiserIds: [] },
  { key: 'health', label: 'Health', emoji: '🏥', metaKeywords: ['supplements'], googleAdvertiserIds: [] },
  { key: 'home', label: 'Home', emoji: '🏠', metaKeywords: ['home decor'], googleAdvertiserIds: [] },
  { key: 'pets', label: 'Pets', emoji: '🐶', metaKeywords: ['pet supplies'], googleAdvertiserIds: [] },
  { key: 'software', label: 'Software', emoji: '💻', metaKeywords: ['saas software'], googleAdvertiserIds: [] },
  { key: 'books', label: 'Books', emoji: '📚', metaKeywords: ['books'], googleAdvertiserIds: [] },
  { key: 'services', label: 'Services', emoji: '🛠️', metaKeywords: ['online course'], googleAdvertiserIds: [] },
] as const;

export type IndustryKey = (typeof INDUSTRIES)[number]['key'];

/** All industry keys in Figma order — keeps the literal union `as const` paid for. */
export const INDUSTRY_KEYS = INDUSTRIES.map(
  (i) => i.key
) as readonly IndustryKey[];

/** A Set for O(1) membership checks. */
const INDUSTRY_KEY_SET = new Set<string>(INDUSTRY_KEYS);

/**
 * Zod enum over the industry keys for route schemas. Built from a non-empty
 * tuple so `z.enum` is happy and stays in sync with `INDUSTRIES` — and keeps
 * the literal-typed keys so downstream code never needs an `as IndustryKey`.
 */
export const industryKeyEnum = z.enum(
  INDUSTRY_KEYS as [IndustryKey, ...IndustryKey[]]
);

/** Lookup one industry definition by key (undefined if unknown). */
export function getIndustry(key: string): IndustryDefinition | undefined {
  return INDUSTRIES.find((i) => i.key === key);
}

/** Whether a string is a known industry key. */
export function isIndustryKey(key: string): boolean {
  return INDUSTRY_KEY_SET.has(key);
}

/**
 * Identity-extraction pack — PURE (synthesis-playbook posture). Assembles
 * the deterministic model input from crawled pages + the founder-confirmed
 * profile + a sample of own ad copy, and fingerprints it so an unchanged
 * pack never re-runs the LLM (cost gate).
 */
import { createHash } from 'node:crypto';
import { BRAND_OBJECT_CONFIG } from '../config';

export interface CrawledPage {
  url: string;
  text: string;
}

export interface IdentityProfileInput {
  brandName: string;
  websiteUrl: string;
  productDescription: string | null;
  category: string | null;
  competitors: string[];
}

export interface OwnAdCopy {
  adId: string;
  texts: string[];
}

export interface IdentityPack {
  system: string;
  user: string;
  fingerprint: string;
  pageCount: number;
}

export function buildIdentityPack(
  profile: IdentityProfileInput,
  pages: CrawledPage[],
  ownAds: OwnAdCopy[],
): IdentityPack {
  const cfg = BRAND_OBJECT_CONFIG.crawl;
  const usablePages = pages
    .filter((page) => page.text.trim().length >= cfg.minPageChars)
    .slice(0, cfg.maxPages)
    .map((page) => ({
      url: page.url,
      text: page.text.slice(0, cfg.maxPageChars),
    }));

  const system = [
    'You are a brand strategist extracting a structured brand identity from a',
    "brand's own website pages and ad copy. Extract ONLY what the source",
    'material supports. For every claim EXCEPT voice, copy the single exact',
    'sentence from the source that supports it into source_sentence (verbatim,',
    'no paraphrasing — unverifiable claims are discarded) and name the page it',
    'came from in source_url. The voice card is DERIVED from overall tone and',
    'carries no source sentence. Compliance notes are restrictions/claims the',
    'brand must respect in advertising (regulated categories, guarantees,',
    'certifications). Return every array — empty when nothing qualifies.',
  ].join(' ');

  const user = JSON.stringify(
    {
      brand: {
        name: profile.brandName,
        website: profile.websiteUrl,
        product_description: profile.productDescription,
        category: profile.category,
        competitors: profile.competitors,
      },
      pages: usablePages,
      own_ad_copy: ownAds.map((ad) => ({
        ad_id: ad.adId,
        texts: ad.texts.slice(0, 8),
      })),
    },
    null,
    2,
  );

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        profile: [
          profile.brandName,
          profile.websiteUrl,
          profile.productDescription,
          profile.category,
          [...profile.competitors].sort(),
        ],
        pages: usablePages.map((page) => [
          page.url,
          createHash('sha256').update(page.text).digest('hex'),
        ]),
        ads: ownAds.map((ad) => [ad.adId, ad.texts]).sort(),
      }),
    )
    .digest('hex');

  return { system, user, fingerprint, pageCount: usablePages.length };
}

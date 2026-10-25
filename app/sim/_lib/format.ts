import type { CreativeRow } from '@/lib/spacetime/bindings/types';

// Browser copies of the few sim formats the views need. The originals live in sim/ (B's engine),
// which the web app doesn't import; keep these in step with them:
//   renderAd, postRef, the tap question   sim/src/render.ts, sim/src/feed.ts
//   PAGE_QUESTIONS                        sim/src/feed.ts
//   calibrate, P_MIN, P_MAX               sim/src/calibrate.ts
//   CPM_USD                               sim/src/config.ts (reward.cpmUsd)

export const CPM_USD = 13.88;
export const JEV_MODEL = 'jev-1.13.0';
// For a live cost estimate before a round's summary lands (about 700 input tokens a call, B1).
export const TOKENS_PER_CALL = 700;
export const USD_PER_MILLION_TOKENS = 0.042;

export type Offsets = { tap: number; stay: number; buy: number };

export function parseJson<T>(text: string | undefined | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const P_MIN = 0.005;
const P_MAX = 0.995;
export function calibrate(pRaw: number, offset: number): number {
  const p = Math.min(P_MAX, Math.max(P_MIN, pRaw));
  if (offset === 0) return p;
  return 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + offset)));
}

export function costPerOrder(reward: number): number | null {
  return reward > 0 ? CPM_USD / 1000 / reward : null;
}

export function renderAd(c: CreativeRow, brandName: string): string {
  const image = c.visualDescription ? ` [Image: ${c.visualDescription}]` : '';
  const headline = /[.!?"”]$/.test(c.headline) ? c.headline : `${c.headline}.`;
  return `${brandName}: ${headline} ${c.primaryText} [Button: ${c.cta}]${image}`;
}

export function postRef(c: CreativeRow, brandName: string): string {
  return `the ${brandName} post that says "${c.headline.replace(/^["“](.*)["”]$/, '$1')}"`;
}

export type NoulQuestion = { type: 'noul'; instructions: string };
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };

export const tapQuestion = (c: CreativeRow, brandName: string): NoulQuestion => ({
  type: 'noul',
  instructions: `Does this shopper tap ${postRef(c, brandName)} to learn more?`,
});
export const believesQuestion = (c: CreativeRow, brandName: string): NoulQuestion => ({
  type: 'noul',
  instructions: `Does this shopper believe the main promise of ${postRef(c, brandName)}?`,
});

export const OBJECTIONS = {
  price: 'The price is more than they want to pay.',
  taste_doubt: 'They doubt it tastes good.',
  trust: "They don't trust the brand or its claims.",
  not_now: "They don't need cereal right now.",
  other_brand: "They'd rather buy another brand.",
  nothing: 'Nothing is holding them back.',
};

export const PAGE_QUESTIONS = {
  stays: { type: 'noul', instructions: 'Does the shopper look through this page instead of leaving within a few seconds?' },
  buys: { type: 'noul', instructions: 'If they stay, do they buy on this visit?' },
  objection: { type: 'choice', instructions: 'What is the main thing holding them back, if anything?', criteria: OBJECTIONS },
} as const;

export const pct = (p: number | null | undefined, digits = 1) =>
  p === null || p === undefined || !Number.isFinite(p) ? '–' : `${(p * 100).toFixed(digits)}%`;
export const usd = (x: number | null | undefined, digits = 2) =>
  x === null || x === undefined || !Number.isFinite(x) ? '–' : `$${x.toFixed(digits)}`;
export const words = (token: string | null | undefined) => (token ? token.replaceAll('_', ' ') : '');

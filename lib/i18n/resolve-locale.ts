/**
 * Pure locale resolution for `i18n/request.ts` (plan decision D2):
 * `adcero-locale` cookie → best `Accept-Language` match → `DEFAULT_LOCALE`.
 */
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/config';
import { parseLocaleCookieValue } from './locale-cookie';

interface WeightedTag {
  tag: string;
  q: number;
  index: number;
}

function parseQuality(params: string[]): number {
  for (const param of params) {
    const [name, value] = param.split('=').map((part) => part.trim());
    if (name?.toLowerCase() === 'q') {
      const q = Number(value);
      return Number.isFinite(q) ? q : 0;
    }
  }
  return 1;
}

/**
 * Picks the highest-weighted `Accept-Language` entry whose language subtag is a
 * supported locale (`pt-PT` → `pt`, `es-MX` → `es`). Entries with `q=0` and the
 * `*` wildcard never match. Ties keep header order.
 */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;

  const entries: WeightedTag[] = [];
  header.split(',').forEach((raw, index) => {
    const [tagPart, ...params] = raw.split(';');
    const tag = tagPart?.trim().toLowerCase();
    if (!tag || tag === '*') return;
    const q = parseQuality(params);
    if (q <= 0) return;
    entries.push({ tag, q, index });
  });

  entries.sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag } of entries) {
    const language = tag.split('-')[0];
    if (isLocale(language)) return language;
  }
  return null;
}

export function resolveLocale(input: {
  cookieValue?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  return (
    parseLocaleCookieValue(input.cookieValue) ??
    matchAcceptLanguage(input.acceptLanguage) ??
    DEFAULT_LOCALE
  );
}

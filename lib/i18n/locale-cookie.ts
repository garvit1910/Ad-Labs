/**
 * The `adcero-locale` cookie — the per-request source of truth for the UI
 * language (plan decision D2). Client-safe: no `next/headers` import, so both
 * `i18n/request.ts` (server) and the settings language picker (client) can use
 * these helpers.
 */
import { isLocale, type Locale } from '@/i18n/config';

export const LOCALE_COOKIE_NAME = 'adcero-locale';

/** One year, in seconds. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Returns the locale stored in the cookie, or `null` when absent or unsupported. */
export function parseLocaleCookieValue(value: string | undefined | null): Locale | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isLocale(trimmed) ? trimmed : null;
}

/**
 * Reads the locale from `document.cookie` in the browser; `null` on the server,
 * when absent, or when unsupported.
 */
export function readLocaleCookieClient(): Locale | null {
  if (typeof document === 'undefined') return null;
  const entry = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE_NAME}=`));
  return parseLocaleCookieValue(entry?.slice(LOCALE_COOKIE_NAME.length + 1));
}

export function buildLocaleCookieString(locale: Locale, opts?: { secure?: boolean }): string {
  const parts = [
    `${LOCALE_COOKIE_NAME}=${locale}`,
    'Path=/',
    `Max-Age=${LOCALE_COOKIE_MAX_AGE}`,
    'SameSite=Lax',
  ];
  if (opts?.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Writes the cookie from the browser. Callers follow up with `router.refresh()`
 * so the server re-renders with the new locale. No-op outside the browser.
 */
export function setLocaleCookieClient(locale: Locale): void {
  if (typeof document === 'undefined') return;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:';
  document.cookie = buildLocaleCookieString(locale, { secure });
}

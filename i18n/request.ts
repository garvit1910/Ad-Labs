/**
 * next-intl request config, picked up by the `next-intl/plugin` wrapper in
 * `next.config.ts` from this default path.
 *
 * Ad Lab (REUSE_MANIFEST §8.3): English only. Only `messages/en.json` is
 * copied, so there is no locale cookie, Accept-Language negotiation or
 * catalog merge; every request renders `en`.
 */
import { IntlErrorCode, type IntlError } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config';
import { formats } from './formats';
import en from '../messages/en.json';

type Messages = typeof en;

export async function loadMessages(_locale: Locale): Promise<Messages> {
  return en;
}

const warnedErrors = new Set<string>();

export function createOnError(locale: Locale) {
  return function onError(error: IntlError): void {
    if (error.code === IntlErrorCode.MISSING_MESSAGE && locale === DEFAULT_LOCALE) {
      return;
    }
    const key = `${error.code}:${error.message}`;
    if (warnedErrors.has(key)) return;
    // Bounded: a long-lived server process must not accumulate keys forever.
    if (warnedErrors.size >= 500) warnedErrors.clear();
    warnedErrors.add(key);
    console.warn(`[i18n] ${locale}: ${error.message}`);
  };
}

export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: en,
  formats,
  onError: createOnError(DEFAULT_LOCALE),
}));

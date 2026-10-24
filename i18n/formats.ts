/**
 * Shared named formats for next-intl (`format.number(v, 'percent')`, `format.dateTime(d, 'short')`).
 * Passed to the request config and therefore to `NextIntlClientProvider`.
 */
import type { Formats } from 'next-intl';

export const formats = {
  dateTime: {
    short: { dateStyle: 'medium' },
    long: { dateStyle: 'long' },
    time: { timeStyle: 'short' },
  },
  number: {
    percent: { style: 'percent', maximumFractionDigits: 1 },
    compact: { notation: 'compact', maximumFractionDigits: 1 },
    integer: { maximumFractionDigits: 0 },
  },
} satisfies Formats;

/**
 * Display formatting for the "What's working for you" chapter — the ONE set of
 * formatters every report track uses (screen panel, Brand Book sheet, headless
 * PDF chapter). A print surface must import these, never restate them: two
 * local copies of a money or ROAS format silently drift (CLAUDE.md "every
 * display-formatting rule is applied on the print surface by IMPORTING the
 * screen's helper").
 *
 * PURE, zero imports, client-safe.
 *
 * Every formatter takes an optional trailing `locale` (an Intl tag such as
 * `fr-CA`). Omitted, the output is the historical en-US text byte for byte —
 * the headless PDF and the server model pass nothing until the print i18n
 * phase; the on-screen panel passes the user's tag.
 */

/** The historical (and print) formatting locale. */
const DEFAULT_FORMAT_LOCALE = 'en-US';

/** Two fixed decimals: `toFixed` without a locale (unchanged output), the
 * locale's decimal separator with one. */
function fixed2(value: number, locale?: string): string {
  return locale
    ? new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: false,
      }).format(value)
    : value.toFixed(2);
}

/** Shown wherever a ratio is withheld because purchases are under the floor. */
export const NOT_ENOUGH_PURCHASES_LABEL = 'not enough purchases';

/**
 * Money in the model's (already converted) display currency. Whole units at
 * 100 and above — a spend table reads in dollars, not cents — and two
 * decimals below, where the cents carry the meaning (a $4.37 CPA). An
 * unrecognized currency code degrades to "CODE 1,234" instead of throwing.
 */
export function formatPerformanceMoney(
  amount: number,
  currency: string,
  locale: string = DEFAULT_FORMAT_LOCALE,
): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const fractionDigits = Math.abs(value) >= 100 ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })}`;
  }
}

/** "3.42×" — or null when the ratio was withheld. */
export function formatRoas(roas: number | null, locale?: string): string | null {
  if (roas == null || !Number.isFinite(roas)) return null;
  return `${fixed2(roas, locale)}×`;
}

/** "1.24%" click-through — or null when there were no impressions. */
export function formatCtr(ctr: number | null, locale?: string): string | null {
  if (ctr == null || !Number.isFinite(ctr)) return null;
  return locale
    ? new Intl.NumberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(ctr / 100)
    : `${ctr.toFixed(2)}%`;
}

/** A share of spend, rounded; a real but sub-half-percent share reads "<1%". */
export function formatSharePct(pct: number, locale?: string): string {
  const whole = (value: number) =>
    locale
      ? new Intl.NumberFormat(locale, {
          style: 'percent',
          maximumFractionDigits: 0,
        }).format(value / 100)
      : `${value}%`;
  if (!Number.isFinite(pct) || pct <= 0) return whole(0);
  if (pct < 0.5) return `<${whole(1)}`;
  return whole(Math.round(pct));
}

/** "last 30 days" — the window phrase every caption uses. */
export function performanceWindowLabel(windowDays: number): string {
  return `last ${windowDays} day${windowDays === 1 ? '' : 's'}`;
}

/**
 * "Labeled ads cover 86% of spend in the last 30 days" — or null when the org
 * had no spend at all in the window (nothing to cover).
 */
export function performanceCoverageCaption(params: {
  labeledSpend: number;
  totalSpend: number;
  windowDays: number;
}): string | null {
  if (!(params.totalSpend > 0)) return null;
  const pct = Math.min(100, (params.labeledSpend / params.totalSpend) * 100);
  return `Labeled ads cover ${formatSharePct(pct)} of spend in the ${performanceWindowLabel(
    params.windowDays,
  )}`;
}

/**
 * The ruler caption. Returns are `purchase_value ÷ spend` exactly as each ad
 * platform reports them (the platform ruler) — not Adcero-verified revenue.
 */
export function performanceBasisCaption(currency: string): string {
  return `Platform-reported: purchase value ÷ spend as each ad platform reports it, in ${currency}`;
}

/**
 * The multi-brand banner. Own ads carry no brand, so a multi-brand org sees one
 * pooled read — said out loud, never faked as a per-brand filter.
 */
export function performancePooledBanner(scope: {
  pooled: boolean;
  brandCount: number;
}): string | null {
  if (!scope.pooled) return null;
  return `Organization-wide — own-ad labels are not split per brand (${scope.brandCount} brands)`;
}

/**
 * Pure URL/slug helpers for the Trustpilot Reviews source (no network). A
 * Trustpilot business unit is keyed by an EXACT slug string that MAY include
 * a `www.` prefix — `www.beeinspiredclothing.com` and `beeinspiredclothing.com`
 * are DIFFERENT units (the 2026-07-16 Bee Inspired 0-review incident). The
 * founder either lets us derive the slug from their website, pastes a
 * Trustpilot page URL, or picks a fallback candidate. Nothing here hits the
 * network: a wrong slug triggers the actor's INTERNAL search fallback, so the
 * resolve probe (not these helpers) is the real validator; a dead/wrong page
 * surfaces as a degraded card, never a billable full scrape.
 * `normalizeDomain` is the canonical COMPARISON form used by the probe's
 * wrong-company gate — never build a scrape target from it; targeting always
 * uses the exact slug (`sanitizeTrustpilotSlug`).
 */

/** Hosts like trustpilot.com / www.trustpilot.com / fr.trustpilot.com. */
const TRUSTPILOT_HOST_PATTERN = /(^|\.)trustpilot\.com$/;

/**
 * Canonical COMPARISON form for a bare domain: trimmed, lowercased, leading
 * `www.` and trailing dots stripped. Null for empty/whitespace garbage. Used
 * by the resolve probe's wrong-company gate (the actor's company-block domain
 * vs the expected slug) — no dot requirement, it is pure canonicalization.
 * NEVER build a scrape target from this form: stripping `www.` can retarget a
 * different Trustpilot unit. Use `sanitizeTrustpilotSlug` for targeting.
 */
export function normalizeDomain(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  const host = trimmed.replace(/^www\./, '').replace(/\.+$/, '');
  return host === '' ? null : host;
}

/**
 * Canonicalize then require a real domain shape (one dot, host chars only).
 * The shared tail for both derivation paths.
 */
function toDomainOrNull(host: string): string | null {
  const normalized = normalizeDomain(host);
  if (!normalized) return null;
  if (!normalized.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(normalized)) return null;
  return normalized;
}

/**
 * Sanitize an EXACT Trustpilot unit slug for targeting: trimmed, lowercased,
 * trailing dots stripped, real domain shape required — but a leading `www.`
 * is PRESERVED (units are keyed by exact string; stripping it retargets a
 * different, possibly empty, unit). Use this for anything that becomes a
 * `/review/<slug>` scrape target; use `normalizeDomain` only to compare.
 */
export function sanitizeTrustpilotSlug(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  const slug = trimmed.replace(/\.+$/, '');
  if (slug === '') return null;
  if (!slug.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(slug)) return null;
  return slug;
}

/**
 * Derive the bare Trustpilot slug from the founder's website URL — the
 * primary "Find our Trustpilot page" path. Accepts a full URL
 * (`https://www.nike.com/shoes?x=1`) or a bare domain (`nike.com`); strips
 * protocol, `www.`, path, query, hash, port, and trailing dots to
 * `'nike.com'`. Tolerates a missing protocol. Null for empty input or a host
 * with no dot / invalid characters. Deliberately bare (www-stripped): this is
 * only a SEED guess — the resolve probe's `probe → probe_www` ladder covers
 * units that are actually keyed on the `www.` variant.
 */
export function deriveTrustpilotDomain(
  websiteUrl: string | null | undefined,
): string | null {
  if (!websiteUrl) return null;
  let raw = websiteUrl.trim();
  if (raw === '') return null;
  // Tolerate a missing protocol so bare domains parse through URL().
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }
  return toDomainOrNull(host);
}

/** True when the host is trustpilot.com or a subdomain (www., locale like fr.). */
export function isTrustpilotUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return TRUSTPILOT_HOST_PATTERN.test(url.hostname.toLowerCase());
}

/**
 * Extract the reviewed unit slug from a Trustpilot review URL
 * (`https://www.trustpilot.com/review/nike.com?languages=all` → `'nike.com'`).
 * The slug is preserved EXACTLY (incl. a leading `www.` —
 * `/review/www.beeinspiredclothing.com` → `'www.beeinspiredclothing.com'`);
 * extra trailing path segments after the slug are allowed. Null for
 * non-Trustpilot hosts or a URL missing the `/review/<slug>` segment.
 */
export function parseTrustpilotUrl(raw: string): string | null {
  if (!isTrustpilotUrl(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const match = /^\/review\/([^/?#]+)/.exec(url.pathname);
  if (!match) return null;
  let slug = match[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw segment if it isn't valid percent-encoding
  }
  return sanitizeTrustpilotSlug(slug);
}

/** Build the canonical review URL from a bare domain slug. */
export function trustpilotUrlFromDomain(domain: string): string {
  return `https://www.trustpilot.com/review/${domain}`;
}

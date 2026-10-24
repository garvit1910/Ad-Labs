/**
 * Fetches website content from a URL.
 *
 * - `fetchWebsiteHtml` returns the raw (un-stripped) HTML, so callers can mine
 *   it for links/markup (e.g. discovering a brand's Facebook page link).
 * - `fetchWebsiteContent` returns plain text with all markup stripped, for LLM
 *   ingestion (brand-summary generation).
 *
 * Both share the same fetch internals: browser headers, www/non-www variation,
 * 10s timeout, and retryable rate-limit / server-error classification.
 */

import {
  fetchPinnedRemoteResponse,
  isRedirectResponse,
  validateSafeRemoteUrl,
} from "@/lib/video-fetch-utils";
import { BrandSummaryError } from "./errors";

/** Cap raw HTML so a single homepage can't blow up memory on huge pages. */
const RAW_HTML_MAX_BYTES = 500_000;

/** Redirect hops followed before giving up (each hop is re-validated). */
const MAX_REDIRECT_HOPS = 5;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
} as const;

/**
 * SSRF-safe website fetch (the URL is user-supplied). Every hop — the initial
 * URL and each redirect target — is validated with DNS resolution and fetched
 * through a dispatcher pinned to the validated address, so neither a redirect
 * to an internal host nor DNS rebinding can reach private targets. Mirrors the
 * `lib/video-fetch-utils.ts` safe-fetch standard from `app/api/CLAUDE.md`.
 */
async function tryFetch(
  url: string,
  timeoutMs: number = 10000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const validation = await validateSafeRemoteUrl(currentUrl, {
        allowedProtocols: ["http:", "https:"],
      });
      if (!validation.valid) {
        throw new Error(
          `Blocked unsafe website URL${hop > 0 ? " (redirect target)" : ""}: ${validation.reason}`,
        );
      }

      const response = await fetchPinnedRemoteResponse(
        validation.parsed,
        validation.pinnedAddress,
        { headers: BROWSER_HEADERS, signal: controller.signal },
      );

      if (isRedirectResponse(response)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Redirect response without a Location header");
        }
        currentUrl = new URL(location, validation.parsed).toString();
        continue;
      }

      return response;
    }
    throw new Error(`Too many redirects (more than ${MAX_REDIRECT_HOPS})`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildUrlVariations(url: string): string[] {
  let normalizedUrl = url.match(/^https?:\/\//) ? url : `https://${url}`;
  normalizedUrl = normalizedUrl.replace(/\/$/, "");

  const urlVariations: string[] = [];
  try {
    const parsed = new URL(normalizedUrl);
    const hasWww = parsed.hostname.startsWith("www.");
    urlVariations.push(normalizedUrl);

    if (!hasWww) {
      urlVariations.push(
        `${parsed.protocol}//www.${parsed.hostname}${parsed.pathname}${parsed.search}`,
      );
    } else {
      urlVariations.push(
        `${parsed.protocol}//${parsed.hostname.replace("www.", "")}${parsed.pathname}${parsed.search}`,
      );
    }
  } catch {
    urlVariations.push(normalizedUrl);
  }
  return urlVariations;
}

/**
 * Fetches a URL (trying www/non-www variations) and returns the raw HTML body.
 * Throws a retryable {@link BrandSummaryError} on rate-limit / 5xx, and a plain
 * Error when the site is unreachable or otherwise blocking requests.
 */
async function fetchRawHtml(url: string): Promise<string> {
  const urlVariations = buildUrlVariations(url);

  let lastError: Error | null = null;
  let lastStatus: number | null = null;
  let sawRateLimit = false;

  for (const urlToTry of urlVariations) {
    try {
      console.log(`[brand-summary] Trying to fetch: ${urlToTry}`);
      const response = await tryFetch(urlToTry);

      if (!response.ok) {
        console.log(`[brand-summary] HTTP ${response.status} for ${urlToTry}`);
        lastStatus = response.status;
        sawRateLimit = sawRateLimit || response.status === 429;
        lastError = new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
        continue;
      }

      const html = await response.text();
      console.log(
        `[brand-summary] Successfully fetched ${urlToTry}, html length: ${html.length}`,
      );
      return html;
    } catch (error) {
      console.log(
        `[brand-summary] Failed to fetch ${urlToTry}:`,
        error instanceof Error ? error.message : error,
      );
      lastError = error instanceof Error ? error : new Error("Unknown error");
    }
  }

  if (sawRateLimit) {
    throw new BrandSummaryError({
      code: "WEBSITE_FETCH_RATE_LIMITED",
      reason: "The website rate-limited the brand summary fetch request",
      remediation:
        "Retry automatically later or provide brand guidelines manually if the website continues blocking server-side requests",
      retryable: true,
      status: 429,
      cause: lastError,
    });
  }

  if (lastStatus && lastStatus >= 500) {
    throw new BrandSummaryError({
      code: "WEBSITE_FETCH_FAILED",
      reason:
        "The website returned a temporary server error while fetching brand summary content",
      remediation:
        "Retry automatically later or confirm the website is available",
      retryable: true,
      status: 503,
      cause: lastError,
    });
  }

  // Unreachable, blocking (4xx, network failure, unsafe/blocked URL): an
  // expected, user-fixable condition, not an internal error. 422 like the
  // Brand Identity website routes (`competitors/suggest`, `resolve-website`),
  // never 502: the upstream is the customer's own site, and a 5xx would invite
  // blind retries of something only the user can fix. Not retryable (a site
  // 5xx/429 above is). The last low-level error is kept in `cause` too.
  throw new BrandSummaryError({
    code: "WEBSITE_FETCH_FAILED",
    reason: `Failed to fetch website content. The website may be unavailable or blocking requests. Last error: ${lastError?.message || "Unknown error"}`,
    remediation:
      "Check that the website URL is correct and publicly reachable, or fill in the brand guidelines manually in Settings → Organization",
    retryable: false,
    status: 422,
    cause: lastError,
  });
}

/** Caps raw HTML to {@link RAW_HTML_MAX_BYTES}. */
function capHtml(html: string): string {
  return html.length > RAW_HTML_MAX_BYTES
    ? html.slice(0, RAW_HTML_MAX_BYTES)
    : html;
}

/** Strips all markup from HTML to LLM-ready plain text (truncated to 15k). */
function stripHtmlToText(html: string): string {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > 15000) {
    text = text.substring(0, 15000) + "...";
  }

  return text;
}

/** Fetches a website's raw HTML (capped), trying www/non-www variations. */
export async function fetchWebsiteHtml(url: string): Promise<string> {
  return capHtml(await fetchRawHtml(url));
}

/** Fetches a website and returns plain text with all markup stripped. */
export async function fetchWebsiteContent(url: string): Promise<string> {
  return stripHtmlToText(await fetchRawHtml(url));
}

/**
 * Fetches a website ONCE and returns both the capped raw HTML (for color mining
 * — `<style>`, `style=`, and hex/rgb literals survive) and the stripped plain
 * text (for the LLM summary). Avoids the double fetch of calling
 * `fetchWebsiteHtml` and `fetchWebsiteContent` separately.
 */
export async function fetchWebsiteHtmlAndText(
  url: string,
): Promise<{ html: string; text: string }> {
  const raw = await fetchRawHtml(url);
  return { html: capHtml(raw), text: stripHtmlToText(raw) };
}

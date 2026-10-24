import type { ApifyClient } from 'apify-client';
import {
  createApifyClient,
  getApifyControlTimeoutMs,
} from '@/services/ad-library/apify-config';
import { withApifyTimeout } from '@/services/ad-library/apify-timeout';
import { BRAND_OBJECT_CONFIG } from '@/lib/brand-object/config';

/**
 * apify/website-content-crawler (Actor ID aYG0l9s7dbB7j3gbS). Two call paths:
 *
 * 1. `fetchHomepageText` — a real-browser crawler behind Apify residential
 *    proxies, the fallback for brand homepages that block a plain server-side
 *    `fetch()` with a 403 / bot-challenge (Cloudflare/Akamai). Used ONLY by
 *    Brand Presence discovery when `fetchWebsiteContent`
 *    (lib/brand-summary/fetch-website.ts) is blocked; the cheap plain fetch
 *    stays the default path. One page, so the proxy bytes stay small.
 *
 * 2. `startCrawl` / `getCrawlStatus` / `collectCrawlPages` — the multi-page
 *    Layer-3 identity crawl (brand_object_crawl), TIERED for cost. The `http`
 *    tier (the default) is `crawlerType: 'cheerio'` — plain HTTP, no asset
 *    loading — on the Apify datacenter proxy (not residential) at a small
 *    memory size. The `browser` tier
 *    is playwright:firefox + RESIDENTIAL proxy, which the processor escalates
 *    to only when the http tier yields no usable page or fails. Why: measured
 *    on the Apify account, a browser+residential crawl cost $0.72–1.08, ~96%
 *    of it 0.8–1.0 GB of residential bandwidth at $8/GB because the browser
 *    pulls every asset of every page through the proxy.
 *
 * Input fields verified against the live default build (2026-07-09): `startUrls`,
 * `crawlerType` (enum incl. 'playwright:firefox', 'cheerio'), `maxCrawlPages`,
 * `maxCrawlDepth`, `proxyConfiguration`, `saveMarkdown`, `maxResults`.
 */
export const WEBSITE_CONTENT_CRAWLER_ACTOR_ID =
  process.env.BRAND_PRESENCE_WEBSITE_ACTOR_ID?.trim() ||
  'apify~website-content-crawler';

/** Cap the extracted text for LLM parity with `fetchWebsiteContent`. */
const MAX_TEXT_CHARS = 15000;
/** Bounded inline wait — this is a single quick page, not a long crawl. */
const DEFAULT_MAX_WAIT_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;

export class WebsiteProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'WebsiteProviderError';
    this.retryable = opts.retryable;
  }
}

/**
 * `http` = plain-HTTP cheerio crawl on the datacenter proxy (cheap, the default);
 * `browser` = playwright:firefox behind residential proxies (the escalation).
 */
export type CrawlTier = 'http' | 'browser';

/** Pure actor input for the multi-page identity crawl at a given tier. */
export function buildCrawlInput(
  url: string,
  opts: { maxPages: number; tier: CrawlTier },
): Record<string, unknown> {
  if (opts.tier === 'http') {
    return {
      startUrls: [{ url }],
      // Plain HTTP + HTML parse — no browser, so no images/fonts/scripts
      // are downloaded.
      crawlerType: 'cheerio',
      maxCrawlPages: opts.maxPages,
      maxCrawlDepth: 1,
      maxResults: opts.maxPages,
      // Apify datacenter proxy (no `apifyProxyGroups` = the default auto
      // group) — NOT residential, so no $8/GB residential bandwidth. The
      // actor's input schema REQUIRES a proxy: `{ useApifyProxy: false }`
      // without custom proxyUrls is rejected at run start ("Field
      // input.proxyConfiguration is required", live 2026-09-28).
      proxyConfiguration: { useApifyProxy: true },
      saveMarkdown: true,
    };
  }
  return {
    startUrls: [{ url }],
    crawlerType: 'playwright:firefox',
    // Home + directly-linked key pages (about/product/FAQ live one hop
    // from the homepage on almost every brand site).
    maxCrawlPages: opts.maxPages,
    maxCrawlDepth: 1,
    maxResults: opts.maxPages,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
    },
    saveMarkdown: true,
  };
}

interface WebsiteCrawlerItem {
  text?: string;
  markdown?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Real-browser + residential-proxy fallback fetch for a single brand homepage.
 * Mirrors the Layer-1/Reddit Apify providers (start → status-keyed poll → read
 * the persisted dataset), but collapsed to one bounded inline call because the
 * caller needs the text before it can extract the draft profile.
 */
export class WebsiteApifyProvider {
  private readonly client: ApifyClient;

  constructor(client?: ApifyClient) {
    this.client = client ?? createApifyClient();
  }

  private buildInput(url: string) {
    return {
      startUrls: [{ url }],
      // A real browser is what gets past Cloudflare/Akamai; Firefox is the
      // actor default and the least fingerprinted of the options.
      crawlerType: 'playwright:firefox',
      // Homepage only — never follow links.
      maxCrawlPages: 1,
      maxCrawlDepth: 0,
      maxResults: 1,
      // Residential IPs — the whole point of the fallback.
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
      },
      saveMarkdown: true,
    };
  }

  /**
   * Returns the homepage's extracted plain text, or throws
   * {@link WebsiteProviderError}. Bounded by `maxWaitMs`; aborts the run before
   * giving up so it stops accruing Apify usage.
   */
  async fetchHomepageText(
    url: string,
    opts: { signal?: AbortSignal; maxWaitMs?: number } = {},
  ): Promise<string> {
    const { signal } = opts;
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

    let runId: string;
    let datasetId: string;
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client
          .actor(WEBSITE_CONTENT_CRAWLER_ACTOR_ID)
          .start(this.buildInput(url)),
        getApifyControlTimeoutMs(),
      );
      runId = run.id;
      datasetId = run.defaultDatasetId;
    } catch (error) {
      throw new WebsiteProviderError(
        `Website crawler failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }

    const deadline = Date.now() + maxWaitMs;
    try {
      for (;;) {
        if (signal?.aborted) {
          await this.abortQuietly(runId);
          throw new WebsiteProviderError('Website crawl aborted', {
            retryable: true,
          });
        }
        const run = await withApifyTimeout(
          'run poll (get)',
          this.client.run(runId).get(),
          getApifyControlTimeoutMs(),
        );
        const status = run?.status;
        if (status === 'SUCCEEDED') break;
        if (status && status !== 'READY' && status !== 'RUNNING') {
          // FAILED / TIMED-OUT / ABORTED / ABORTING / missing run.
          throw new WebsiteProviderError(
            `Website crawl did not succeed (status: ${status})`,
            { retryable: status !== 'ABORTED' },
          );
        }
        if (Date.now() >= deadline) {
          await this.abortQuietly(runId);
          throw new WebsiteProviderError('Website crawl timed out', {
            retryable: true,
          });
        }
        await sleep(POLL_INTERVAL_MS, signal);
      }
    } catch (error) {
      if (error instanceof WebsiteProviderError) throw error;
      // `sleep` rejects on abort.
      await this.abortQuietly(runId);
      throw new WebsiteProviderError(
        error instanceof Error ? error.message : 'Website crawl failed',
        { retryable: true },
      );
    }

    const { items } = await withApifyTimeout(
      'dataset listItems',
      this.client.dataset(datasetId).listItems({ clean: true, limit: 1 }),
      getApifyControlTimeoutMs(),
    );
    const first = items[0] as WebsiteCrawlerItem | undefined;
    const text = (first?.text ?? first?.markdown ?? '').trim();
    if (!text) {
      throw new WebsiteProviderError('Website crawl returned no content', {
        retryable: false,
      });
    }
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  }

  private async abortQuietly(runId: string): Promise<void> {
    try {
      await withApifyTimeout(
        'run abort',
        this.client.run(runId).abort(),
        getApifyControlTimeoutMs(),
      );
    } catch {
      /* best-effort — the run may already be terminal */
    }
  }

  // ---------------------------------------------------------------------
  // Multi-page crawl lifecycle (Layer 3 identity extraction). ADDITIVE —
  // fetchHomepageText above stays byte-identical. Split into start / status
  // / collect so the brand_object_crawl processor can checkpoint the runId
  // and resume across FunctionTimeoutError pauses (the adlib run-lifecycle
  // pattern) instead of holding one long inline wait.
  // ---------------------------------------------------------------------

  /**
   * Starts a depth-1 crawl of up to `maxPages` same-site pages at `tier`
   * (default `http`). The http tier also pins a small run memory; the
   * browser tier keeps the actor-default memory.
   */
  async startCrawl(
    url: string,
    opts: { maxPages: number; tier?: CrawlTier },
  ): Promise<{ runId: string; datasetId: string }> {
    const tier: CrawlTier = opts.tier ?? 'http';
    const input = buildCrawlInput(url, { maxPages: opts.maxPages, tier });
    const runOptions =
      tier === 'http'
        ? { memory: BRAND_OBJECT_CONFIG.crawl.httpTierMemoryMb }
        : {};
    try {
      const run = await withApifyTimeout(
        'run start',
        this.client
          .actor(WEBSITE_CONTENT_CRAWLER_ACTOR_ID)
          .start(input, runOptions),
        getApifyControlTimeoutMs(),
      );
      return { runId: run.id, datasetId: run.defaultDatasetId };
    } catch (error) {
      throw new WebsiteProviderError(
        `Website crawl failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
  }

  /** Raw Apify status string, or 'MISSING' when the run cannot be read. */
  async getCrawlStatus(runId: string): Promise<string> {
    const run = await withApifyTimeout(
      'run poll (get)',
      this.client.run(runId).get(),
      getApifyControlTimeoutMs(),
    );
    return run?.status ?? 'MISSING';
  }

  async abortCrawl(runId: string): Promise<void> {
    await this.abortQuietly(runId);
  }

  /** Collects crawled pages (url + extracted text) from a SUCCEEDED run. */
  async collectCrawlPages(
    datasetId: string,
    opts: { maxPages: number; maxPageChars: number },
  ): Promise<Array<{ url: string; text: string }>> {
    const { items } = await withApifyTimeout(
      'dataset listItems',
      this.client.dataset(datasetId).listItems({ clean: true, limit: opts.maxPages }),
      getApifyControlTimeoutMs(),
    );
    const pages: Array<{ url: string; text: string }> = [];
    for (const item of items as Array<
      WebsiteCrawlerItem & { url?: string }
    >) {
      const text = (item.text ?? item.markdown ?? '').trim();
      if (!item.url || !text) continue;
      pages.push({
        url: item.url,
        text:
          text.length > opts.maxPageChars
            ? text.slice(0, opts.maxPageChars)
            : text,
      });
    }
    return pages;
  }
}

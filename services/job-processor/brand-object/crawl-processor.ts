/**
 * brand_object_crawl — multi-page website crawl for identity extraction.
 * Apify website-content-crawler via the run lifecycle (start → checkpoint
 * runId in cursors.crawl.sync → status-keyed poll → FunctionTimeoutError
 * resume — the adlib pattern; state-based staleness, abort-before-abandon).
 * Tiered for cost: the first run is the cheap `http` tier (cheerio,
 * datacenter proxy) unless BRAND_OBJECT_CRAWL_TIER=browser; an http run that fails or
 * yields zero usable pages escalates ONCE to the `browser` tier
 * (playwright + residential proxy). The tier lives in the checkpointed
 * cursor so a resume never restarts at http.
 * Pages are archived to R2 (the data handoff to the identity job, not
 * best-effort provenance) and content-hashed so an unchanged site never
 * re-runs the identity LLM. A fully blocked/empty crawl DEGRADES rather
 * than dead-ends: identity runs on profile fields + own ad copy alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRAND_OBJECT_CONFIG } from '@/lib/brand-object/config';
import { createHash } from 'node:crypto';
import {
  WebsiteApifyProvider,
  WebsiteProviderError,
  type CrawlTier,
} from '@/services/brand-presence/website-apify-provider';
import { r2Service } from '@/services/r2-service';
import type { FunctionTimeoutTracker } from '../function-timeout';
import { FunctionTimeoutError } from '../function-timeout';
import type { Job } from '../types';
import { enqueueBrandObjectIdentity } from './queue';
import {
  ensureBrandObjectState,
  mergeBrandObjectState,
  recordBrandObjectUsage,
  type CrawlCursor,
} from './state';
import { brandObjectCrawlPayloadSchema } from './types';

const R2_BUCKET = 'adcero-ad-creatives';
const POLL_INTERVAL_MS = 5_000;

interface CrawlSync {
  runId?: string;
  datasetId?: string;
  startedAt?: string;
  /** Tier of the checkpointed run; absent on pre-tier cursors (= browser). */
  tier?: CrawlTier;
}

/**
 * First-run crawl tier. `BRAND_OBJECT_CRAWL_TIER=browser` is the kill switch
 * back to the pre-tier behaviour (every crawl on playwright + residential).
 * Read at call time so a flip needs no redeploy of cached modules.
 */
export function resolveCrawlTier(): CrawlTier {
  const raw = process.env.BRAND_OBJECT_CRAWL_TIER?.trim();
  if (!raw) return 'http';
  if (raw === 'http' || raw === 'browser') return raw;
  console.warn(
    `[BrandObject] Invalid BRAND_OBJECT_CRAWL_TIER "${raw}" — using "http"`,
  );
  return 'http';
}

export class BrandObjectCrawlProcessor {
  private readonly provider: WebsiteApifyProvider;

  constructor(
    private readonly _db: SupabaseClient,
    provider?: WebsiteApifyProvider,
  ) {
    this.provider = provider ?? new WebsiteApifyProvider();
  }

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<void> {
    const payload = brandObjectCrawlPayloadSchema.parse(job.payload);
    const { organizationId, brandProfileId, force, chain } = payload;
    const label = `[BrandObject] Crawl ${brandProfileId}`;
    const cfg = BRAND_OBJECT_CONFIG.crawl;

    const state = await ensureBrandObjectState(
      this._db,
      organizationId,
      brandProfileId,
    );
    const cursor: CrawlCursor & { sync?: CrawlSync } = {
      ...(state.cursors?.crawl ?? {}),
    };

    // Cooldown: a recent crawl is served from its stored R2 refs.
    const lastCrawledAt = cursor.lastCrawledAt
      ? Date.parse(cursor.lastCrawledAt)
      : 0;
    const fresh =
      Date.now() - lastCrawledAt < cfg.cooldownDays * 24 * 60 * 60 * 1000;
    if (fresh && !force && !cursor.sync?.runId) {
      console.log(`${label}: within cooldown — reusing stored pages`);
      await this.chainIdentity(payload, this.storedRefs(cursor), label, chain);
      return;
    }

    const { data: profile, error: profileError } = await this._db
      .from('brand_presence_profiles')
      .select('id, website_url')
      .eq('organization_id', organizationId)
      .eq('id', brandProfileId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile?.website_url) {
      console.warn(`${label}: profile has no website_url — degrading`);
      await this.chainIdentity(payload, [], label, chain);
      return;
    }

    // Start or resume the checkpointed run.
    const websiteUrl = String(profile.website_url);
    let sync: CrawlSync = cursor.sync ?? {};
    if (!sync.runId || !sync.datasetId) {
      sync = await this.startRun(
        websiteUrl,
        resolveCrawlTier(),
        organizationId,
        brandProfileId,
        cursor,
      );
    }

    let pages: Array<{ url: string; text: string }>;
    for (;;) {
      // A cursor from before tiering has no tier: it was a browser run.
      const tier: CrawlTier = sync.tier ?? 'browser';
      const status = await this.pollRun(
        sync,
        organizationId,
        brandProfileId,
        cursor,
        label,
        signal,
        timeoutTracker,
      );
      if (status !== 'SUCCEEDED') {
        if (tier === 'http' && status !== 'ABORTED') {
          console.warn(
            `${label}: http-tier run ${sync.runId} ended ${status} — escalating to browser tier`,
          );
          sync = await this.startRun(
            websiteUrl,
            'browser',
            organizationId,
            brandProfileId,
            cursor,
          );
          continue;
        }
        await this.clearSync(organizationId, brandProfileId, cursor);
        throw new WebsiteProviderError(
          `${label}: crawl run ${sync.runId} ended ${status}`,
          { retryable: status !== 'ABORTED' },
        );
      }

      pages = (
        await this.provider.collectCrawlPages(sync.datasetId!, {
          maxPages: cfg.maxPages,
          maxPageChars: cfg.maxPageChars,
        })
      ).filter((page) => page.text.length >= cfg.minPageChars);

      if (
        pages.length === 0 &&
        tier === 'http' &&
        cfg.escalateToBrowserWhenEmpty
      ) {
        console.warn(
          `${label}: http-tier run ${sync.runId} yielded 0 usable pages — escalating to browser tier`,
        );
        await this.clearSync(organizationId, brandProfileId, cursor);
        sync = await this.startRun(
          websiteUrl,
          'browser',
          organizationId,
          brandProfileId,
          cursor,
        );
        continue;
      }
      break;
    }

    // Archive pages to R2 — the handoff to the identity job. A write failure
    // fails the job (retryable): a crawl we can't hand off is worthless.
    const startedStamp = (sync.startedAt ?? new Date().toISOString()).replace(
      /[:.]/g,
      '-',
    );
    const pageHashes: Record<string, string> = {};
    const pageRefs: Record<string, string> = {};
    for (let i = 0; i < pages.length; i++) {
      const key = `brand-object/${organizationId}/${brandProfileId}/crawl/${startedStamp}-page${i}.json`;
      await r2Service.uploadFile(
        R2_BUCKET,
        key,
        JSON.stringify(pages[i]),
        'application/json',
        { source: 'brand-object-crawl' },
      );
      pageHashes[pages[i].url] = createHash('sha256')
        .update(pages[i].text)
        .digest('hex');
      pageRefs[pages[i].url] = key;
    }

    const unchanged =
      Object.keys(pageHashes).length > 0 &&
      JSON.stringify(sortRecord(pageHashes)) ===
        JSON.stringify(sortRecord(cursor.pageHashes ?? {}));

    await this.saveCursor(organizationId, brandProfileId, {
      pageHashes,
      pageRefs,
      lastCrawledAt: new Date().toISOString(),
      sync: undefined,
    });

    console.log(
      `${label}: ${pages.length} pages archived${unchanged ? ' (content unchanged)' : ''}`,
    );
    await this.chainIdentity(payload, Object.values(pageRefs), label, chain);
  }

  /** Starts a run at `tier`, checkpoints it, and meters one Apify run. */
  private async startRun(
    url: string,
    tier: CrawlTier,
    organizationId: string,
    brandProfileId: string,
    cursor: CrawlCursor & { sync?: CrawlSync },
  ): Promise<CrawlSync> {
    const started = await this.provider.startCrawl(url, {
      maxPages: BRAND_OBJECT_CONFIG.crawl.maxPages,
      tier,
    });
    const sync: CrawlSync = {
      ...started,
      startedAt: new Date().toISOString(),
      tier,
    };
    await this.saveCursor(organizationId, brandProfileId, { ...cursor, sync });
    await recordBrandObjectUsage(this._db, organizationId, brandProfileId, {
      apifyRuns: 1,
    });
    return sync;
  }

  /**
   * Status-keyed poll until the run leaves READY/RUNNING (state-based
   * staleness; wall ceiling for wedged runs, measured from this run's own
   * `startedAt`). Returns the terminal status; the caller decides whether a
   * non-success escalates or throws.
   */
  private async pollRun(
    sync: CrawlSync,
    organizationId: string,
    brandProfileId: string,
    cursor: CrawlCursor & { sync?: CrawlSync },
    label: string,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
  ): Promise<string> {
    const cfg = BRAND_OBJECT_CONFIG.crawl;
    const startedAtMs = sync.startedAt ? Date.parse(sync.startedAt) : Date.now();
    for (;;) {
      if (signal.aborted) throw new Error('Brand object job aborted');
      if (timeoutTracker?.shouldStop()) {
        throw new FunctionTimeoutError(
          'Function timeout - will resume on next cron',
        );
      }
      const status = await this.provider.getCrawlStatus(sync.runId!);
      if (status !== 'READY' && status !== 'RUNNING') return status;
      if (Date.now() - startedAtMs > cfg.runTimeoutMs) {
        await this.provider.abortCrawl(sync.runId!);
        await this.clearSync(organizationId, brandProfileId, cursor);
        throw new WebsiteProviderError(`${label}: crawl run wedged, aborted`, {
          retryable: true,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private storedRefs(cursor: CrawlCursor & { pageRefs?: Record<string, string> }): string[] {
    return Object.values(
      (cursor as { pageRefs?: Record<string, string> }).pageRefs ?? {},
    );
  }

  private async chainIdentity(
    payload: { organizationId: string; brandProfileId: string; chain?: boolean },
    crawlRefs: string[],
    label: string,
    chain?: boolean,
  ): Promise<void> {
    if (!chain) return;
    const { jobId, deduped } = await enqueueBrandObjectIdentity(this._db, {
      organizationId: payload.organizationId,
      brandProfileId: payload.brandProfileId,
      crawlRefs,
      chain: true,
    });
    console.log(
      `${label}: identity ${deduped ? 'already queued' : 'queued'} (${jobId}, ${crawlRefs.length} pages)`,
    );
  }

  private async saveCursor(
    organizationId: string,
    brandProfileId: string,
    crawl: CrawlCursor & { sync?: CrawlSync; pageRefs?: Record<string, string> },
  ): Promise<void> {
    await mergeBrandObjectState(this._db, organizationId, brandProfileId, {
      cursors: { crawl },
    });
  }

  private async clearSync(
    organizationId: string,
    brandProfileId: string,
    cursor: CrawlCursor & { sync?: CrawlSync },
  ): Promise<void> {
    await this.saveCursor(organizationId, brandProfileId, {
      ...cursor,
      sync: undefined,
    });
  }
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

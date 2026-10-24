import type { SupabaseClient } from '@supabase/supabase-js';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { LlmProviderError } from '@/lib/llm/errors';
import {
  getAngleVocabulary,
  getPersonaVocabulary,
} from '@/lib/brand-identity/industry-taxonomy';
import { getIndustry } from '@/lib/brand-identity/industries';
import { fetchVideoPart } from './video-context';
import { labelVideoAd } from './video-label';
import {
  FunctionTimeoutError,
  type FunctionTimeoutTracker,
} from '../function-timeout';
import type { Job } from '../types';
import { maybeEnqueueMarketAfterAdlibSync } from '@/services/job-processor/brand-object/queue';
import { findUnlabeledAdIds } from './sync';
import { adlibLabelBatchPayloadSchema } from './types';
import {
  buildLabelRequestBody,
  buildSystemPrompt,
  copySiblingLabels,
  dedupeByLibraryAdId,
  fetchPoster,
  isVideoCardCarousel,
  labelResponseSchema,
  parseLabelItem,
  planLabelCalls,
  posterUrl,
  resolveDurationBucket,
  staticImageCardCount,
  toLabelRow,
  type AdToLabel,
  type LabelRow,
} from './label';
import { modelForRole } from '@/lib/llm/model-roles';

// The label pipeline's building blocks (media/card math, prompt + request
// construction, model-output parsing, row mapping, sibling copy) live in
// ./label; this module keeps the original import path as a barrel for the
// existing consumers (own-ads processor, eval scripts, tests).
export * from './label';

/**
 * Max concurrent whole-video Gemini label calls per invocation
 * (`ADLIB_VIDEO_LABEL_CONCURRENCY` overrides). Unbounded fan-out — one
 * 150s-deadline call per video, all at once — let a 15-video batch pin the
 * invocation past the /api/jobs/process budget (observed live 2026-07-05: hard
 * kill → retry into the same overload → attempts exhausted, batch dead). A
 * small cap keeps each wave's wall clock bounded so the budget check between
 * pulls can pause the job gracefully before the hard kill.
 */
const DEFAULT_VIDEO_LABEL_CONCURRENCY = 3;

function videoLabelConcurrency(): number {
  const raw = Number(process.env.ADLIB_VIDEO_LABEL_CONCURRENCY);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_VIDEO_LABEL_CONCURRENCY;
}

/**
 * adlib_label_batch — labels a batch of library ads and upserts ad_labels rows
 * (idempotent: already-labeled ads are skipped, upsert is keyed on
 * library_ad_id).
 *
 * Ads in one batch can span competitors/industries, so they are grouped by the
 * competitor's industry and labelled one LLM call per group with that industry's
 * angle vocabulary. Unclassified competitors fall back to the universal angles.
 */
export class AdLibraryLabelBatchProcessor {
  constructor(private readonly _db: SupabaseClient) {}

  async process(
    job: Job,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker
  ): Promise<void> {
    const payload = adlibLabelBatchPayloadSchema.parse(job.payload);
    const { organizationId, libraryAdIds } = payload;

    const { data: ads, error: adsError } = await this._db
      .from('library_ads')
      .select(
        'id, competitor_id, creative_bodies, creative_link_titles, media_type, page_name, media_urls, video_urls, platform, external_ad_id'
      )
      .eq('organization_id', organizationId)
      .in('id', libraryAdIds);
    if (adsError) throw adsError;

    const { data: existingLabels, error: labelsError } = await this._db
      .from('ad_labels')
      .select('library_ad_id')
      .eq('organization_id', organizationId)
      .in('library_ad_id', libraryAdIds);
    if (labelsError) throw labelsError;
    const alreadyLabeled = new Set(
      (existingLabels ?? []).map((row) => String(row.library_ad_id))
    );

    const toLabel = ((ads ?? []) as AdToLabel[]).filter(
      (ad) => !alreadyLabeled.has(ad.id)
    );
    if (toLabel.length === 0) {
      console.log(`[AdLibLabel] Job ${job.id}: all ads already labeled, skipping`);
      // A resumed post-pause batch can be the competitor's LAST one.
      await this.maybeFireMarketHooks(organizationId, (ads ?? []) as AdToLabel[]);
      return;
    }

    // Resolve each ad's industry from its competitor so the right angle
    // vocabulary is used (catalog seeds carry industry; user brands may too).
    const industryByAd = await this.resolveIndustryByAd(organizationId, toLabel);

    const model = modelForRole('ad_label');
    const nowIso = new Date().toISOString();

    // Cross-org reuse: an ad is PUBLIC, so the same (platform, external_ad_id)
    // tracked by a sibling org is the same creative. When that sibling already
    // labeled it under a competitor with OUR ad's industry (angle vocabulary is
    // industry-specific, so the copy is only valid on an industry match), copy
    // its label instead of re-calling the LLM. Fails OPEN — any error warns and
    // every ad falls through to the normal LLM path below.
    const copied = await copySiblingLabels(
      this._db,
      organizationId,
      toLabel,
      industryByAd,
      job.id
    );

    // Copied ads are already labeled; the rest proceed exactly as before.
    const remainingToLabel = toLabel.filter((ad) => !copied.has(ad.id));
    if (remainingToLabel.length === 0) {
      console.log(
        `[AdLibLabel] Job ${job.id}: copied ${copied.size}/${toLabel.length} sibling labels, none left for the LLM`
      );
      await this.maybeFireMarketHooks(organizationId, (ads ?? []) as AdToLabel[]);
      return;
    }

    // Group ads by industry key ('' = unclassified → universal vocabulary).
    const groups = new Map<string, AdToLabel[]>();
    for (const ad of remainingToLabel) {
      const key = industryByAd.get(ad.id) ?? '';
      const list = groups.get(key) ?? [];
      list.push(ad);
      groups.set(key, list);
    }

    // Rows persist per industry group (and mid-group on a budget pause), not
    // in one batch-final upsert: a hard-killed invocation used to lose every
    // completed LLM call, so each retry redid the full batch and hit the same
    // overload. Already-labeled ads are skipped on resume, so every persisted
    // row permanently shrinks the remaining work.
    let persistedCount = 0;
    const persistRows = async (rows: LabelRow[]): Promise<void> => {
      if (rows.length === 0) return;
      // The LLM can occasionally emit two entries for the same library_ad_id;
      // a Postgres upsert keyed on library_ad_id then fails ("ON CONFLICT DO
      // UPDATE command cannot affect row a second time"). Keep the first per id.
      const dedupedRows = dedupeByLibraryAdId(rows);
      const { error: upsertError } = await this._db
        .from('ad_labels')
        .upsert(dedupedRows, { onConflict: 'library_ad_id' });
      if (upsertError) throw upsertError;
      persistedCount += dedupedRows.length;
    };

    for (const [industryKey, groupAds] of groups) {
      if (timeoutTracker?.shouldStop()) {
        throw new FunctionTimeoutError(
          'Function timeout - will resume on next cron'
        );
      }
      const labeled = await this.labelGroup(
        organizationId,
        groupAds,
        industryKey || null,
        model,
        nowIso,
        signal,
        timeoutTracker,
        persistRows
      );
      await persistRows(labeled);
    }

    if (persistedCount === 0) {
      throw new Error(
        `LLM labelling returned no valid items for ${remainingToLabel.length} ads`
      );
    }

    console.log(
      `[AdLibLabel] Job ${job.id}: labeled ${persistedCount}/${remainingToLabel.length} ads with ${model} across ${groups.size} industry group(s)` +
        (copied.size > 0 ? ` (copied ${copied.size} sibling labels)` : '')
    );

    await this.maybeFireMarketHooks(organizationId, (ads ?? []) as AdToLabel[]);
  }


  /**
   * Layer-3 hook (fail-soft): when this batch leaves a competitor with ZERO
   * unlabeled ads, the label corpus for that competitor is fully drained —
   * the drain check IS the "last batch" signal (there is no batch-count
   * marker; Layer-2 relevance-finalize precedent). Nudges a market re-derive
   * for opted-in brands. Never fires on the FunctionTimeoutError pause path
   * (the throw skips the process() tail).
   */
  private async maybeFireMarketHooks(
    organizationId: string,
    ads: AdToLabel[]
  ): Promise<void> {
    try {
      const competitorIds = Array.from(
        new Set(
          ads
            .map((ad) => ad.competitor_id)
            .filter((id): id is string => !!id)
            .map(String)
        )
      );
      for (const competitorId of competitorIds) {
        const unlabeled = await findUnlabeledAdIds(
          this._db,
          organizationId,
          competitorId
        );
        if (unlabeled.length > 0) continue;
        await maybeEnqueueMarketAfterAdlibSync(this._db, {
          organizationId,
          competitorId,
        });
      }
    } catch (error) {
      console.warn(
        '[AdLibLabel] Market hook failed (non-fatal)',
        error instanceof Error ? error.message : error
      );
    }
  }

  /** Maps each ad id → its competitor's industry key (when set). */
  private async resolveIndustryByAd(
    organizationId: string,
    ads: AdToLabel[]
  ): Promise<Map<string, string | null>> {
    const competitorIds = Array.from(
      new Set(ads.map((ad) => ad.competitor_id).filter((id): id is string => !!id))
    );
    const industryByCompetitor = new Map<string, string | null>();
    if (competitorIds.length > 0) {
      const { data: competitors, error } = await this._db
        .from('tracked_competitors')
        .select('id, industry')
        .eq('organization_id', organizationId)
        .in('id', competitorIds);
      if (error) throw error;
      for (const row of competitors ?? []) {
        industryByCompetitor.set(String(row.id), (row.industry as string | null) ?? null);
      }
    }
    const byAd = new Map<string, string | null>();
    for (const ad of ads) {
      byAd.set(ad.id, ad.competitor_id ? industryByCompetitor.get(ad.competitor_id) ?? null : null);
    }
    return byAd;
  }

  /**
   * Labels one industry-homogeneous group. Postered ads are labelled one LLM
   * call each (multi-image binding is unreliable); posterless ads share one
   * batched text-only call. See planLabelCalls.
   */
  private async labelGroup(
    organizationId: string,
    groupAds: AdToLabel[],
    industryKey: string | null,
    model: string,
    nowIso: string,
    signal: AbortSignal,
    timeoutTracker?: FunctionTimeoutTracker,
    persist?: (_rows: LabelRow[]) => Promise<void>
  ): Promise<LabelRow[]> {
    const angleVocab = getAngleVocabulary(industryKey);
    const personaVocab = getPersonaVocabulary(industryKey);
    const industryLabel = industryKey ? getIndustry(industryKey)?.label ?? null : null;

    // Vision input: download each ad's poster frame so `format`/`style` (visual
    // judgments) are made from the pixels, not the caption. Failures degrade
    // that ad to text-only — never the batch. The poster also yields the
    // deterministic aspect_ratio bucket.
    const posterByAdId = new Map<string, string>();
    const aspectRatioByAdId = new Map<string, string>();
    await Promise.all(
      groupAds.map(async (ad) => {
        const url = posterUrl(ad);
        if (!url) return;
        const poster = await fetchPoster(url);
        if (!poster) return;
        posterByAdId.set(ad.id, poster.dataUrl);
        if (poster.aspectRatio) aspectRatioByAdId.set(ad.id, poster.aspectRatio);
      })
    );

    // Video ads with a retrievable video get the full-context Gemini pass
    // (motion + audio → style, pacing, voiceover, spoken hook). Everything
    // else — including videos whose mp4 is dead or oversized — takes the
    // OpenAI poster/text path.
    const videoPartByAdId = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof fetchVideoPart>>>
    >();
    await Promise.all(
      groupAds.map(async (ad) => {
        // A single video ad, OR a carousel whose cards are all videos: label
        // from the moving lead creative via Gemini, not the static poster.
        if (ad.media_type !== 'video' && !isVideoCardCarousel(ad)) return;
        const url = ad.video_urls?.[0];
        if (!url) return;
        const part = await fetchVideoPart(url);
        if (part) videoPartByAdId.set(ad.id, part);
      })
    );

    const videoAds = groupAds.filter((ad) => videoPartByAdId.has(ad.id));
    const posterPathAds = groupAds.filter((ad) => !videoPartByAdId.has(ad.id));

    const allowedAngles = new Set(angleVocab);
    const allowedPersonas = new Set(personaVocab);
    const knownAdIds = new Set(groupAds.map((ad) => ad.id));
    const carouselEligibleAdIds = new Set(
      groupAds.filter((ad) => staticImageCardCount(ad) >= 2).map((ad) => ad.id)
    );

    const labelOneVideo = async (ad: AdToLabel): Promise<LabelRow | null> => {
      const videoPart = videoPartByAdId.get(ad.id)!;
      try {
        const result = await labelVideoAd({
          ad: {
            id: ad.id,
            creative_bodies: ad.creative_bodies,
            creative_link_titles: ad.creative_link_titles,
            media_type: ad.media_type,
            page_name: ad.page_name,
          },
          videoPart,
          angleVocab,
          personaVocab,
          systemPrompt: buildSystemPrompt(industryLabel),
        });
        if (result) {
          const item = parseLabelItem(
            result.item,
            knownAdIds,
            allowedAngles,
            allowedPersonas,
            carouselEligibleAdIds
          );
          if (item) {
            // Deterministic duration_bucket: a measured video length beats the
            // LLM. When we couldn't measure it (YouTube — no bytes), fall back
            // to the model's numeric duration_seconds estimate if present.
            const bucket = resolveDurationBucket(videoPart, result.item);
            if (bucket && item.fingerprint) {
              item.fingerprint = { ...item.fingerprint, duration_bucket: bucket };
            } else if (bucket) {
              item.fingerprint = { duration_bucket: bucket };
            }
            return toLabelRow(
              item,
              organizationId,
              result.model,
              nowIso,
              aspectRatioByAdId.get(ad.id) ?? null,
              true
            );
          }
        }
        // Unusable Gemini output — fall through to the poster path below.
      } catch (error) {
        // A PERMANENT per-video failure (e.g. a private/removed YouTube video
        // → Gemini PERMISSION_DENIED) must degrade THIS ad to the poster
        // path, not fail the batch: propagating it killed all 15 ads in the
        // batch for one bad video (observed live, 2026-07-05). Retryable
        // provider errors still propagate so the queue retries the job.
        if (!(error instanceof LlmProviderError) || error.retryable) {
          throw error;
        }
        console.warn(
          `[AdLibLabel] video labelling failed permanently for ad ${ad.id} (${error.code}); falling back to poster path`
        );
      }
      const fallbackRows = await this.labelCall(
        organizationId,
        [ad],
        posterByAdId,
        aspectRatioByAdId,
        angleVocab,
        personaVocab,
        industryLabel,
        model,
        nowIso,
        signal
      );
      return fallbackRows[0] ?? null;
    };

    // Bounded worker pool over the video ads (see videoLabelConcurrency).
    // Each worker checks the soft function budget before pulling the next
    // video; when it trips, workers stop starting new calls so the completed
    // rows can persist and the job pauses instead of being hard-killed.
    const videoRows: LabelRow[] = [];
    let videoBudgetExhausted = false;
    let nextVideoIndex = 0;
    const videoWorkers = Array.from(
      { length: Math.min(videoLabelConcurrency(), videoAds.length) },
      async () => {
        while (nextVideoIndex < videoAds.length) {
          if (timeoutTracker?.shouldStop()) {
            videoBudgetExhausted = true;
            return;
          }
          const ad = videoAds[nextVideoIndex++];
          const row = await labelOneVideo(ad);
          if (row) videoRows.push(row);
        }
      }
    );

    // One call per postered ad (image↔ad binding breaks in multi-image
    // requests — see planLabelCalls), one shared call for the text-only rest.
    const callGroups = planLabelCalls(posterPathAds, posterByAdId);
    const posterRowsPromise = Promise.all(
      callGroups.map((callAds) =>
        this.labelCall(
          organizationId,
          callAds,
          posterByAdId,
          aspectRatioByAdId,
          angleVocab,
          personaVocab,
          industryLabel,
          model,
          nowIso,
          signal
        )
      )
    );

    const [, posterRows] = await Promise.all([
      Promise.all(videoWorkers),
      posterRowsPromise,
    ]);
    const rows = [...videoRows, ...posterRows.flat()];

    if (videoBudgetExhausted) {
      // Keep what finished (video rows + the fast poster/text rows), then
      // pause; the resumed job skips the persisted ads and labels the rest.
      await persist?.(rows);
      throw new FunctionTimeoutError(
        'Function timeout - will resume on next cron'
      );
    }
    return rows;
  }

  /** One LLM labelling request over `callAds` (a planLabelCalls group). */
  private async labelCall(
    organizationId: string,
    callAds: AdToLabel[],
    posterByAdId: Map<string, string>,
    aspectRatioByAdId: Map<string, string>,
    angleVocab: readonly string[],
    personaVocab: readonly string[],
    industryLabel: string | null,
    model: string,
    nowIso: string,
    signal: AbortSignal
  ): Promise<LabelRow[]> {
    // Retryable provider failures (LlmProviderError.retryable) propagate so
    // the queue retries the job up to max_attempts.
    const completion = await openAIChatCompletion({
      body: buildLabelRequestBody(
        callAds,
        model,
        angleVocab,
        personaVocab,
        industryLabel,
        posterByAdId
      ),
      signal,
      retryProfile: 'background',
    });

    const content = (
      completion as { choices?: Array<{ message?: { content?: string } }> }
    ).choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('LLM labelling response had no content');
    }

    let rawItems: unknown[];
    try {
      rawItems = labelResponseSchema.parse(JSON.parse(content)).ads;
    } catch (error) {
      throw new Error(
        `LLM labelling response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const knownAdIds = new Set(callAds.map((ad) => ad.id));
    const allowedAngles = new Set(angleVocab);
    const allowedPersonas = new Set(personaVocab);
    // Ads with 2+ STATIC image cards may carry a carousel label; the rest —
    // including video-card carousels — have it deterministically stripped in
    // parseLabelItem.
    const carouselEligibleAdIds = new Set(
      callAds.filter((ad) => staticImageCardCount(ad) >= 2).map((ad) => ad.id)
    );
    return rawItems
      .map((item) =>
        parseLabelItem(
          item,
          knownAdIds,
          allowedAngles,
          allowedPersonas,
          carouselEligibleAdIds
        )
      )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .map((item) =>
        toLabelRow(
          item,
          organizationId,
          model,
          nowIso,
          aspectRatioByAdId.get(item.library_ad_id) ?? null,
          posterByAdId.has(item.library_ad_id)
        )
      );
  }
}

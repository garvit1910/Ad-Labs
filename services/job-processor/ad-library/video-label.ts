/**
 * Full-video labelling for video ads (Gemini). One ad per call — the same
 * one-visual-per-request binding rule as the OpenAI poster path. The video
 * gives the labeler motion + audio, which the poster frame can't: pacing,
 * voiceover vs talking-head, and the spoken first-3-seconds hook.
 *
 * Output is validated by the SAME zod gate as the OpenAI path
 * (`parseLabelItem` in label-processor.ts) — this module returns the raw
 * parsed JSON item; malformed output returns null and the ad is dropped for
 * this round exactly like a malformed OpenAI item.
 */

import { MediaResolution } from '@google/genai';
import { geminiGenerateContent } from '@/lib/llm/clients/gemini';
import { LlmProviderError } from '@/lib/llm/errors';
import {
  ANGLES,
  FORMATS,
  FUNNEL_STAGES,
  HOOK_ARCHETYPES,
  OFFER_TYPES,
  PACINGS,
  PERSONAS,
  SETTINGS,
  TONES,
  VISUAL_STYLES,
} from '@/services/ad-library/label-taxonomy';
import type { GeminiVideoPart } from './video-context';
import { modelForRole } from '@/lib/llm/model-roles';

// Gemini processes video at ~1fps server-side; a 60s ad takes tens of seconds
// to ingest. The client wrapper has no AbortSignal, so a hard deadline here
// keeps a wedged call from pinning the job past its function budget.
const VIDEO_LABEL_DEADLINE_MS = 150_000;

interface VideoAdInput {
  id: string;
  creative_bodies: string[] | null;
  creative_link_titles: string[] | null;
  media_type: string | null;
  page_name: string | null;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new LlmProviderError({
            provider: 'gemini',
            code: 'GEMINI_TEMPORARY_FAILURE',
            reason: `Video labelling call exceeded ${ms}ms deadline`,
            remediation: 'Let the queued job retry later.',
            retryable: true,
            status: 503,
          })
        ),
      ms
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

function videoAddendum(
  angleVocab: readonly string[],
  personaVocab: readonly string[]
): string {
  return `
You are labelling ONE video ad and you have been given the actual video (with audio). Judge every visual field — format, style, fingerprint — from the video itself; the copy is secondary evidence. Additionally judge the video-only fingerprint attributes:
- voiceover: true when there is narration NOT spoken by a person on camera
- pacing: "static" (no/minimal motion), "slow" (few cuts, gentle motion), "fast" (rapid cuts/high energy)
- spoken_hook: one short line — what is said or shown in the FIRST ~3 seconds
- visual_hook: one short line — what is ON SCREEN in the FIRST ~3 seconds (the visual counterpart of spoken_hook)
- captions: true when burned-in subtitles/captions are present
- music: true when a music track is present (separate from voiceover)
- tone: the emotional register — one of the tone options
- execution_notes: 1-3 short sentences of STAGING DIRECTION another brand could reuse for a different product — camera framing and angle, subject arrangement, props, lighting, environment, mood. Describe only what you see. NEVER include the brand name, page name, product name, any person's name, or any text visible in the creative; write it fully product-agnostic (say "the product", "a person")
- duration_seconds: your best estimate of the video length in seconds (used only when we could not measure it)

Respond with ONLY a JSON object (no prose, no markdown fence) of exactly this shape:
{
  "library_ad_id": string,           // echo the id you were given
  "hook_archetype": ${JSON.stringify([...HOOK_ARCHETYPES])}[number],
  "angle": ${JSON.stringify([...angleVocab])}[number],
  "angle_universal": ${JSON.stringify([...ANGLES])}[number],
  "persona": ${JSON.stringify([...personaVocab])}[number],
  "persona_universal": ${JSON.stringify([...PERSONAS])}[number],
  "funnel_stage": ${JSON.stringify([...FUNNEL_STAGES])}[number],
  "format": ${JSON.stringify([...FORMATS])}[number],
  "style": ${JSON.stringify([...VISUAL_STYLES])}[number],
  "fingerprint": {
    "people_present": boolean,
    "talking_head": boolean,
    "text_overlay": boolean,
    "setting": ${JSON.stringify([...SETTINGS])}[number],
    "tone": ${JSON.stringify([...TONES])}[number],
    "voiceover": boolean,
    "pacing": ${JSON.stringify([...PACINGS])}[number],
    "spoken_hook": string,
    "visual_hook": string,
    "captions": boolean,
    "music": boolean,
    "execution_notes": string
  },
  "offer_type": ${JSON.stringify([...OFFER_TYPES])}[number],
  "hook_text": string,               // first-line hook verbatim from the COPY
  "summary": string,
  "confidence": number,              // 0-1
  "duration_seconds": number         // best estimate of video length in seconds
}`;
}

/** Strips an accidental ```json fence before parsing. */
export function parseGeminiJson(text: string): unknown | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Labels one video ad from its full video. Returns the raw item (to be
 * validated by parseLabelItem) plus the model id used, or null when the model
 * output was unusable. Provider errors propagate (retryable ones let the queue
 * retry the job).
 */
export async function labelVideoAd(params: {
  ad: VideoAdInput;
  videoPart: GeminiVideoPart;
  angleVocab: readonly string[];
  personaVocab: readonly string[];
  systemPrompt: string;
}): Promise<{ item: unknown; model: string } | null> {
  const model = modelForRole('ad_video_label');
  const adJson = JSON.stringify(
    {
      library_ad_id: params.ad.id,
      creative_bodies: params.ad.creative_bodies ?? [],
      creative_link_titles: params.ad.creative_link_titles ?? [],
      media_type: params.ad.media_type ?? 'unknown',
      page_name: params.ad.page_name ?? null,
    },
    null,
    2
  );

  const result = await withDeadline(
    geminiGenerateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${params.systemPrompt}\n${videoAddendum(params.angleVocab, params.personaVocab)}`,
            },
            { text: `Label this ad:\n${adJson}\n\nThe ad's video:` },
            params.videoPart as Record<string, unknown>,
          ],
        },
      ],
      // LOW media resolution caps video at 64 tokens/frame (~4x fewer tokens
      // than the default) — the video pass only needs coarse motion/audio cues
      // (pacing, voiceover-vs-talking-head, spoken hook), not fine text OCR,
      // which the OpenAI poster-frame path already covers. Override-free: this
      // is the only Gemini video call in the pipeline.
      config: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
      },
      retryProfile: 'background',
    }),
    VIDEO_LABEL_DEADLINE_MS
  );

  const item = result.text ? parseGeminiJson(result.text) : null;
  return item ? { item, model } : null;
}

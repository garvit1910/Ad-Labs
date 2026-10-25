import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeChatJson, strictResponseFormat } from '@/lib/brand-presence/llm';
import { openAIChatCompletion } from '@/lib/llm/clients';
import { flexServiceTier } from '@/lib/llm/flex';
import { modelForRole, reasoningParamsForRole } from '@/lib/llm/model-roles';
import { REPO_ROOT } from '../env.mjs';

/*
 * A4's strict-JSON LLM calls, cached on disk so a rerun writes the same rows
 * (B's shoppers and A5's packs read them mid-run) and costs nothing.
 * data/ is gitignored; --refresh asks again.
 */

// Segments and recipes are persona work, so they use the persona model (gpt-5.4).
const ROLE = 'brand_object_personas';
const CACHE_FILE = join(REPO_ROOT, 'data', 'a4', 'llm-cache.json');

export type ChatMessage = { role: 'system' | 'user'; content: string };

export interface Llm {
  /**
   * One strict json_schema call. `parse` validates the decoded payload and throws
   * on anything unusable; only parsed values are cached, so a cached answer that
   * a later version of the code rejects is asked again.
   */
  strictJson<T>(name: string, schema: Record<string, unknown>, messages: ChatMessage[], parse: (value: unknown) => T): Promise<T>;
  stats(): { calls: number; cached: number; model: string };
}

export function createLlm(opts: { refresh: boolean }): Llm {
  const cache: Record<string, unknown> = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
  const model = modelForRole(ROLE);
  let calls = 0;
  let cached = 0;

  return {
    async strictJson(name, schema, messages, parse) {
      // Same body as the persona processor's call; the service tier stays out of the key.
      const body = {
        model,
        messages,
        response_format: strictResponseFormat(name, schema),
        temperature: 0.3,
        ...reasoningParamsForRole(ROLE, model),
      };
      const key = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      if (!opts.refresh && key in cache) {
        try {
          const value = parse(cache[key]);
          cached++;
          return value;
        } catch {
          // fall through and ask again
        }
      }
      calls++;
      const completion = await openAIChatCompletion({ body: { ...body, ...flexServiceTier() }, retryProfile: 'background' });
      const raw = decodeChatJson(completion);
      const value = parse(raw);
      cache[key] = raw;
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
      return value;
    },
    stats: () => ({ calls, cached, model }),
  };
}

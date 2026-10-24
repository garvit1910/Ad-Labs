import { createHash } from "node:crypto";
import type { Asker } from "../src/engine.js";
import { JevClient, type JevResult, type Question, type Questions } from "../src/jev.js";
import { wordCount } from "../src/render.js";

const hashUnit = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest().readUInt32BE(0) / 2 ** 32;

// A stand-in for Jev. A Noul's answer comes from `noul(state, name, question)` when it returns a
// number, else from `fixed` (tap_A/B/C share the key "tap"), else from a hash of (state, name).
// A Choice always picks its first option.
export function fakeJev(
  fixed: Partial<Record<string, number>> = {},
  onAsk?: (state: string) => void,
  noul?: (state: string, name: string, q: Question) => number | undefined,
): Asker {
  return {
    async ask<Q extends Questions>(state: string, questions: Q): Promise<JevResult<Q>> {
      onAsk?.(state);
      const answers: Record<string, unknown> = {};
      for (const [name, q] of Object.entries(questions)) {
        const tapKey = name.startsWith("tap_") ? "tap" : name;
        if (q.type === "noul") {
          const p = noul?.(state, name, q) ?? fixed[tapKey] ?? Math.round(hashUnit(state, name) * 100) / 100;
          answers[name] = { type: "noul", noul: p };
        } else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0]));
          answers[name] = { type: "choice", choice: keys[0], confidence: 1, probabilities };
        }
      }
      const request = { model: "jev-1.13.0", state, questions };
      return {
        model: "jev-1.13.0",
        answers: answers as JevResult<Q>["answers"],
        usage: { input_tokens: wordCount(state), output_tokens: 1 },
        latencyMs: 0,
        cacheHit: false,
        cacheKey: JevClient.cacheKey(request),
        request,
      };
    },
  };
}

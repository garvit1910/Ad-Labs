import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import pLimit from "p-limit";
import { z } from "zod";
import { config } from "./config.js";

// Wrapper for TypeSafe's System One endpoint. Field names are the ones in the OpenAPI
// spec (https://api.typesafe.ai/openapi.json) and are recorded in sim/JEV_API.md.
//
// Request:  { model, state, questions: { <name>: { type, instructions, criteria } } }
// Response: { model, answers: { <name>: { type, ...answer } }, usage: { input_tokens, output_tokens } }

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  // Option name -> description. Key order is the option order the model sees.
  criteria: Record<string, string | null>;
};
export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};
export type ScoreQuestion = {
  type: "score";
  instructions: string;
  // Ordered levels; a level's position is its score, starting at 0.
  criteria: string[];
};
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
const noulAnswer = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});
const scoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number().min(0).max(1),
  legend: z.record(z.string(), z.unknown()),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
const answer = z.discriminatedUnion("type", [choiceAnswer, noulAnswer, scoreAnswer]);

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answer),
  usage: z.object({
    input_tokens: z.number().int().nullable(),
    output_tokens: z.number().int().nullable(),
  }),
});

export type ChoiceAnswer = z.infer<typeof choiceAnswer>;
export type NoulAnswer = z.infer<typeof noulAnswer>;
export type ScoreAnswer = z.infer<typeof scoreAnswer>;
type AnswerFor<Q extends Question> = Q extends ChoiceQuestion
  ? ChoiceAnswer
  : Q extends NoulQuestion
    ? NoulAnswer
    : ScoreAnswer;

export type JevRequest<Q extends Questions> = { model: string; state: string; questions: Q };
export type JevResult<Q extends Questions> = {
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: { input_tokens: number | null; output_tokens: number | null };
  latencyMs: number;
  cacheHit: boolean;
  cacheKey: string;
  request: JevRequest<Q>;
};

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

const PROBABILITY_SUM_TOLERANCE = 0.02;
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

type ParsedResponse = z.infer<typeof responseSchema>;

// Checks the answers against the questions that were asked: every question answered, with
// the same type, and a Choice/Score distribution over exactly the requested options.
function checkAnswers(questions: Questions, answers: ParsedResponse["answers"]): void {
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (!a) throw new JevError(`missing answer for question "${name}"`);
    if (a.type !== q.type) throw new JevError(`answer "${name}" is ${a.type}, asked ${q.type}`);
    if (a.type === "noul" || q.type === "noul") continue;
    const expected = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const got = Object.keys(a.probabilities);
    if (got.length !== expected.length || !expected.every((k) => k in a.probabilities)) {
      throw new JevError(`answer "${name}" options [${got}] != asked [${expected}]`);
    }
    const sum = got.reduce((s, k) => s + (a.probabilities[k] ?? 0), 0);
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
      throw new JevError(`answer "${name}" probabilities sum to ${sum}`);
    }
  }
}

class JevCache {
  private db: Database.Database;
  private getStmt: Database.Statement<[string], { response: string }>;
  private putStmt: Database.Statement<[string, string, string, string]>;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS jev_cache (
      key TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      request TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.getStmt = this.db.prepare("SELECT response FROM jev_cache WHERE key = ?");
    this.putStmt = this.db.prepare(
      "INSERT OR REPLACE INTO jev_cache (key, model, request, response) VALUES (?, ?, ?, ?)",
    );
  }

  get(key: string): unknown | undefined {
    const row = this.getStmt.get(key);
    return row ? JSON.parse(row.response) : undefined;
  }

  put(key: string, model: string, request: string, response: unknown): void {
    this.putStmt.run(key, model, request, JSON.stringify(response));
  }

  close(): void {
    this.db.close();
  }
}

export type JevClientOptions = {
  apiKey?: string;
  model?: string;
  concurrency?: number;
  cachePath?: string | null;
};

export class JevClient {
  readonly model: string;
  private apiKey: string | undefined;
  private limit: ReturnType<typeof pLimit>;
  private cache: JevCache | null;

  constructor(opts: JevClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.model = opts.model ?? config.jev.model;
    this.limit = pLimit(opts.concurrency ?? config.jev.concurrency);
    this.cache = opts.cachePath === null ? null : new JevCache(opts.cachePath ?? config.paths.cacheDb);
  }

  // Cache key = sha256(model version + question spec + state text). The question spec
  // carries the option order, because criteria keys are serialised in insertion order.
  static cacheKey(request: JevRequest<Questions>): string {
    return createHash("sha256").update(JSON.stringify(request)).digest("hex");
  }

  ask<Q extends Questions>(state: string, questions: Q): Promise<JevResult<Q>> {
    const request: JevRequest<Q> = { model: this.model, state, questions };
    const cacheKey = JevClient.cacheKey(request);
    const cached = this.cache?.get(cacheKey);
    if (cached !== undefined) {
      const parsed = responseSchema.parse(cached);
      checkAnswers(questions, parsed.answers);
      return Promise.resolve(toResult(parsed, { latencyMs: 0, cacheHit: true, cacheKey, request }));
    }
    return this.limit(async () => {
      const started = performance.now();
      const raw = await this.post(JSON.stringify(request));
      const latencyMs = Math.round(performance.now() - started);
      const result = responseSchema.safeParse(raw);
      if (!result.success) {
        throw new JevError(`response failed validation: ${z.prettifyError(result.error)}`, 200, JSON.stringify(raw));
      }
      checkAnswers(questions, result.data.answers);
      this.cache?.put(cacheKey, result.data.model, JSON.stringify(request), result.data);
      return toResult(result.data, { latencyMs, cacheHit: false, cacheKey, request });
    });
  }

  // POST with exponential backoff on 429/529/5xx and network errors, honouring retry-after.
  private async post(body: string): Promise<unknown> {
    if (!this.apiKey) throw new JevError("TYPESAFE_API_KEY is not set (put it in .env.local)");
    let lastError: unknown;
    for (let attempt = 0; attempt < config.jev.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(config.jev.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(config.jev.timeoutMs),
        });
      } catch (err) {
        lastError = err;
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return res.json();
      const text = await res.text();
      lastError = new JevError(`Jev HTTP ${res.status}: ${text}`, res.status, text);
      if (!RETRYABLE.has(res.status)) throw lastError;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
    }
    throw lastError;
  }

  close(): void {
    this.cache?.close();
  }
}

// checkAnswers has already matched every answer's type to its question.
function toResult<Q extends Questions>(
  parsed: ParsedResponse,
  extra: Pick<JevResult<Q>, "latencyMs" | "cacheHit" | "cacheKey" | "request">,
): JevResult<Q> {
  return { model: parsed.model, answers: parsed.answers as JevResult<Q>["answers"], usage: parsed.usage, ...extra };
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

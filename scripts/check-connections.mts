import { loadEnv, requireEnv } from "./env.mjs";
import { supabasePg } from "./pg.mjs";

// One tiny call per external service, printed as a pass/fail table. Exits 1 if any fail.
// Plain fetch on purpose: no SDKs, and nothing imported from sim/ (A and B share only SpacetimeDB).

loadEnv();

const TIMEOUT_MS = 30_000;

// Models the reused Adcero code defaults to (docs/PLAN.md "Gotchas to handle early").
// A failing one gets overridden with its role env var (REUSE_MANIFEST §9, CREATIVE_MANIFEST §9).
const CHAT_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-6-luna", "gpt-4o"];
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;
const JEV_MODEL = "jev-1.13.0";

type Check = { service: string; target: string; run: () => Promise<string> };

async function http(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
  return text ? JSON.parse(text) : null;
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

function supabaseRest(): Check {
  return {
    service: "Supabase",
    target: "REST, service role",
    run: async () => {
      const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
      await http(`${requireEnv("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      return "PostgREST answered";
    },
  };
}

function supabasePgvector(): Check {
  return {
    service: "Supabase",
    target: "Postgres + pgvector",
    run: async () => {
      const client = supabasePg();
      await client.connect();
      try {
        const ext = await client.query<{ extversion: string }>(
          "select extversion from pg_extension where extname = 'vector'",
        );
        const version = ext.rows[0]?.extversion;
        if (!version) throw new Error("vector extension not enabled; run npm run setup:supabase");
        const dist = await client.query<{ d: number }>(
          "select '[1,2,3]'::extensions.vector <-> '[1,2,4]'::extensions.vector as d",
        );
        if (dist.rows[0]?.d !== 1) throw new Error(`unexpected L2 distance ${dist.rows[0]?.d}`);
        return `vector ${version}, L2 distance ok`;
      } finally {
        await client.end();
      }
    },
  };
}

function spacetime(): Check {
  return {
    service: "SpacetimeDB",
    target: "ping reducer",
    run: async () => {
      const uri = requireEnv("SPACETIMEDB_URI").replace(/\/$/, "");
      const db = requireEnv("SPACETIMEDB_DB_NAME");
      // A throwaway anonymous identity is enough to call a public reducer.
      const { token } = await http(`${uri}/v1/identity`, { method: "POST" });
      await http(`${uri}/v1/database/${db}/call/ping`, json([], { Authorization: `Bearer ${token}` }));
      return `${db} on ${new URL(uri).host}`;
    },
  };
}

function apify(): Check {
  return {
    service: "Apify",
    target: "user",
    run: async () => {
      const { data } = await http("https://api.apify.com/v2/users/me", {
        headers: { Authorization: `Bearer ${requireEnv("APIFY_TOKEN")}` },
      });
      return `user ${data.username}, plan ${data.plan?.id ?? "?"}`;
    },
  };
}

function openaiChat(model: string): Check {
  return {
    service: "OpenAI",
    target: model,
    run: async () => {
      const body = await http(
        "https://api.openai.com/v1/chat/completions",
        json(
          { model, messages: [{ role: "user", content: "Reply with: ok" }], max_completion_tokens: 16 },
          { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
        ),
      );
      return `answered as ${body.model}`;
    },
  };
}

function openaiEmbedding(): Check {
  return {
    service: "OpenAI",
    target: EMBEDDING_MODEL,
    run: async () => {
      const body = await http(
        "https://api.openai.com/v1/embeddings",
        json({ model: EMBEDDING_MODEL, input: "magic spoon" }, { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` }),
      );
      const dims = body.data?.[0]?.embedding?.length;
      if (dims !== EMBEDDING_DIMS) throw new Error(`expected ${EMBEDDING_DIMS} dims, got ${dims}`);
      return `${dims} dims`;
    },
  };
}

function jev(): Check {
  return {
    service: "Jev (TypeSafe)",
    target: JEV_MODEL,
    run: async () => {
      // Request and response field names: sim/JEV_API.md.
      const body = await http(
        "https://api.typesafe.ai/v1/systemone",
        json(
          {
            model: JEV_MODEL,
            state: "SHOPPER\nA 34-year-old who lifts weights four times a week and reads nutrition labels.",
            questions: { ping: { type: "noul", instructions: "Would this shopper notice a cereal ad that says 13g protein?" } },
          },
          { Authorization: `Bearer ${requireEnv("TYPESAFE_API_KEY")}` },
        ),
      );
      const p = body.answers?.ping?.noul;
      if (typeof p !== "number" || p < 0 || p > 1) throw new Error(`bad noul answer: ${JSON.stringify(body.answers)}`);
      if (body.model !== JEV_MODEL) throw new Error(`answered by ${body.model}, not ${JEV_MODEL}`);
      return `noul ${p.toFixed(2)}`;
    },
  };
}

function asiOne(): Check {
  return {
    service: "ASI:One",
    target: "asi1",
    run: async () => {
      const body = await http(
        "https://api.asi1.ai/v1/chat/completions",
        json(
          { model: "asi1", messages: [{ role: "user", content: "Reply with: ok" }], max_tokens: 16 },
          { Authorization: `Bearer ${requireEnv("ASI1_API_KEY")}` },
        ),
      );
      return `answered as ${body.model ?? "asi1"}`;
    },
  };
}

const checks: Check[] = [
  supabaseRest(),
  supabasePgvector(),
  spacetime(),
  apify(),
  ...CHAT_MODELS.map(openaiChat),
  openaiEmbedding(),
  jev(),
  asiOne(),
];

const results = await Promise.all(
  checks.map(async (c) => {
    const started = performance.now();
    try {
      const detail = await c.run();
      return { ...c, ok: true, ms: performance.now() - started, detail };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ...c, ok: false, ms: performance.now() - started, detail };
    }
  }),
);

const rows = results.map((r) => [r.service, r.target, r.ok ? "PASS" : "FAIL", `${Math.round(r.ms)}`, r.detail]);
const header = ["Service", "Check", "Result", "ms", "Detail"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => Math.min(row[i]!.length, i === 4 ? 90 : 40))));
const line = (cells: string[]) =>
  cells.map((cell, i) => (cell.length > widths[i]! ? cell.slice(0, widths[i]! - 1) + "…" : cell.padEnd(widths[i]!))).join("  ");

console.log(line(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) console.log(line(row));

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);

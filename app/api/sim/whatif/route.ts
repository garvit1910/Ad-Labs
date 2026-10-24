import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { JEV_MODEL, PAGE_QUESTIONS } from '@/app/sim/_lib/format';

// The inspector's what-if: re-ask Jev one of the sim's own questions about a shopper state with
// one line removed. Only the sim's question shapes pass (the feed's tap/believes Nouls, the page's
// stays/buys/objection), the model is pinned, the TypeSafe key stays on the server, and answers
// are cached in memory by sha256 of the exact request, so a repeat toggle never calls Jev again.

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_STATE_CHARS = 6000; // the sim keeps states under 450 words (sim/src/render.ts)
const CACHE_LIMIT = 500;
const cache = new Map<string, unknown>();

type Question = { type: string; instructions: string; criteria?: unknown };

const TAP = /^Does this shopper tap the [^"\n]{1,60} post that says "[^\n]{1,300}" to learn more\?$/;
const BELIEVES = /^Does this shopper believe the main promise of the [^"\n]{1,60} post that says "[^\n]{1,300}"\?$/;

// A feed call: tap_A..tap_C plus optional believes. A page call: exactly PAGE_QUESTIONS.
function allowed(questions: Record<string, Question>): boolean {
  const names = Object.keys(questions);
  if (names.length === 0) return false;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (names.every((n) => n in PAGE_QUESTIONS)) {
    return names.length === 3 && names.every((n) => same(questions[n], PAGE_QUESTIONS[n as keyof typeof PAGE_QUESTIONS]));
  }
  return names.every((n) => {
    const q = questions[n]!;
    const keys = Object.keys(q).sort().join(',');
    if (q.type !== 'noul' || keys !== 'instructions,type') return false;
    if (/^tap_[ABC]$/.test(n)) return TAP.test(q.instructions);
    return n === 'believes' && BELIEVES.test(q.instructions);
  });
}

export async function POST(req: Request) {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'TYPESAFE_API_KEY is not set on the server' }, { status: 503 });

  let body: { state?: unknown; questions?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  const { state, questions } = body;
  if (typeof state !== 'string' || !state.startsWith('SHOPPER\n') || state.length > MAX_STATE_CHARS) {
    return NextResponse.json({ error: 'state must be a sim shopper state' }, { status: 400 });
  }
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !allowed(questions as Record<string, Question>)) {
    return NextResponse.json({ error: "questions must be the sim's feed or page questions" }, { status: 400 });
  }

  const request = JSON.stringify({ model: JEV_MODEL, state, questions });
  const key = createHash('sha256').update(request).digest('hex');
  const hit = cache.get(key);
  if (hit) return NextResponse.json({ ...(hit as object), cached: true });

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: request,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return NextResponse.json({ error: `Jev HTTP ${res.status}` }, { status: 502 });
  const parsed = (await res.json()) as { model?: string; answers?: unknown };
  // A pinned version must answer as itself, or the run's calibration no longer applies.
  if (parsed.model !== JEV_MODEL || !parsed.answers) {
    return NextResponse.json({ error: `asked ${JEV_MODEL}, answered by ${parsed.model ?? 'nothing'}` }, { status: 502 });
  }
  const out = { model: parsed.model, answers: parsed.answers };
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return NextResponse.json({ ...out, cached: false });
}

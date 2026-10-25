import { NextResponse } from 'next/server';
import { DEFAULT_DAY_MS, MAX_DAY_MS, MIN_DAY_MS } from '@/app/sim/_lib/replay';
import { ReplayError, replayInfo, startReplay, stopReplay } from './runner';

// The /sim replay button: GET says whether this server may replay and how the current replay is
// going; POST {from, day_ms} starts one; DELETE stops it.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function GET() {
  return json(replayInfo());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { from?: unknown; day_ms?: unknown };
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  const dayMs = body.day_ms === undefined ? DEFAULT_DAY_MS : Number(body.day_ms);
  if (!from) return json({ error: 'from (a finished run id) is required' }, 400);
  if (!Number.isInteger(dayMs) || dayMs < MIN_DAY_MS || dayMs > MAX_DAY_MS) {
    return json({ error: `day_ms must be a whole number from ${MIN_DAY_MS} to ${MAX_DAY_MS}` }, 400);
  }
  try {
    return json({ replay: await startReplay(from, dayMs) });
  } catch (err) {
    if (err instanceof ReplayError) return json({ error: err.message }, err.status);
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}

export async function DELETE() {
  return json({ replay: stopReplay() });
}

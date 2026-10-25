import { healthSnapshot } from '@/lib/adlab/agent-runtime';
import { ok } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Never throws: an unreachable database shows up as spacetime_ok false.
export async function GET() {
  return ok(await healthSnapshot());
}

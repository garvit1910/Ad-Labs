import { getSpacetime } from '@/lib/adlab/agent-runtime';
import { brandKitStatus } from '@/lib/adlab/brand-kit';
import { handle } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/agent/brand-kit (docs/AGENT_API.md): whether the onboarding step is done. Ad Lab won't
// start a run until `ready`.
export const GET = handle(async () => brandKitStatus(await getSpacetime()));

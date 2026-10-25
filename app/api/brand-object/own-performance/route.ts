import { fail, notAvailable } from '@/lib/adlab/pages/http';

// Ad Lab has no ad-account performance data: always 404, so the chapter hides.
export async function POST() {
  return fail(notAvailable('Own ad performance is not part of Ad Lab'));
}

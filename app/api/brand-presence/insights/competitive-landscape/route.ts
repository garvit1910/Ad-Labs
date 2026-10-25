import { fail, notAvailable } from '@/lib/adlab/pages/http';

// Only Magic Spoon is listened to (one brand_presence_profiles row), so there is
// no landscape to compare: always 404, and the chapter hides.
export async function POST() {
  return fail(notAvailable('No competitor brand profiles are listened to in Ad Lab'));
}

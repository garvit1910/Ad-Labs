import { ADLAB_ORG_ID } from '@/lib/adlab/org';
import { fetchAllEnrichedAdRows, loadTrackedCompetitors } from '@/lib/adlab/pages/ads';
import { orgBody, pageHandler, pagesDb } from '@/lib/adlab/pages/http';
import { EMPTY_OWN_ANGLE_MIX, ownAngleMix } from '@/lib/brand-object/own-angles';

// Magic Spoon's own advertised angle mix, from its own Meta page's labelled ads
// (the is_brand_self tracked competitor; Ad Lab has no own_ad_labels table).
// Fail-soft like Adcero's route: any error gives the zero-ad mix, which
// Chapter 05 reads as "nothing to compare yet".
export const POST = pageHandler({
  schema: orgBody,
  live: async () => {
    try {
      const db = pagesDb();
      const self = await loadTrackedCompetitors(db, { self: true });
      const rows = await fetchAllEnrichedAdRows<{ id: string; angle: string | null; angle_universal: string | null }>(db, {
        organizationId: ADLAB_ORG_ID,
        competitorIds: self.map((c) => c.id),
        columns: 'id, angle, angle_universal',
      });
      return { mix: ownAngleMix(rows.map((r) => ({ angle: r.angle, angleUniversal: r.angle_universal }))) };
    } catch (err) {
      console.error('[pages] own-ad-angles', err);
      return { mix: EMPTY_OWN_ANGLE_MIX };
    }
  },
});

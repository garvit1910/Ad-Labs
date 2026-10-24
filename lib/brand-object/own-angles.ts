/**
 * The brand's OWN advertised angle mix — Chapter 05's counterpart evidence for
 * the winning-angles column.
 *
 * The question that column asks is "the market rewards this argument; do you
 * make it?", and that is a question about the brand's ADS, not its identity
 * claims. Asking it of claims compared a full website sentence against a
 * taxonomy enum ("Price value"), two vocabularies that essentially never
 * intersect, so the column answered red almost regardless of what the brand
 * actually ran — the failure caught live on Magic Spoon (4/4 angles red).
 *
 * Both sides already speak the SAME vocabulary: `services/job-processor/
 * own-ads/label-processor.ts` labels the org's own ads through
 * `getAngleVocabulary(industryKey)`, the identical call the competitor label
 * pipeline makes, so the comparison is exact token equality and needs no
 * matcher at all.
 *
 * Two indexes over one ad set, never a merged map: an own-ad row carries both
 * an industry `angle` and a fallback `angle_universal`, and a market prior may
 * be keyed on either (`priorsByDimension` accepts legacy `angle_universal`
 * rows until an industry row exists). Counting a row into one shared map under
 * both of its tokens would double it; two indexes over the same denominator
 * lets a lookup fall back without ever inflating a share.
 *
 * Pure and JSON-serializable — the mix crosses the route → hook → selector
 * boundary as data.
 */

/** One own-ad label row, narrowed to the angle columns Chapter 05 reads. */
export interface OwnAdAngleRow {
  angle: string | null;
  angleUniversal: string | null;
}

export interface OwnAdAngleMix {
  /**
   * Labeled own ads carrying a usable angle — the share DENOMINATOR, and the
   * flag that says whether this evidence exists at all. Zero means the column
   * has nothing to compare against and must stay neutral, never red.
   */
  totalLabeledAds: number;
  /** Ad count per industry-vocabulary angle token. */
  byAngle: Record<string, number>;
  /** Ad count per universal angle token — the legacy prior vocabulary. */
  byUniversal: Record<string, number>;
}

/** Tag tokens are snake_case; a label may arrive spaced or cased differently. */
export function normalizeAngleToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

export const EMPTY_OWN_ANGLE_MIX: OwnAdAngleMix = {
  totalLabeledAds: 0,
  byAngle: {},
  byUniversal: {},
};

function bump(index: Record<string, number>, raw: string | null): void {
  if (typeof raw !== 'string') return;
  const token = normalizeAngleToken(raw);
  if (token.length === 0) return;
  index[token] = (index[token] ?? 0) + 1;
}

/**
 * Count labeled own ads per angle token. A row with neither angle populated is
 * not evidence of anything and is left out of the denominator entirely, so a
 * share can never be diluted by rows that could not have matched.
 */
export function ownAngleMix(rows: OwnAdAngleRow[]): OwnAdAngleMix {
  const mix: OwnAdAngleMix = {
    totalLabeledAds: 0,
    byAngle: {},
    byUniversal: {},
  };
  for (const row of rows) {
    const hasAngle =
      typeof row.angle === 'string' &&
      normalizeAngleToken(row.angle).length > 0;
    const hasUniversal =
      typeof row.angleUniversal === 'string' &&
      normalizeAngleToken(row.angleUniversal).length > 0;
    if (!hasAngle && !hasUniversal) continue;
    mix.totalLabeledAds += 1;
    bump(mix.byAngle, row.angle);
    bump(mix.byUniversal, row.angleUniversal);
  }
  return mix;
}

/**
 * Own ads carrying a market prior's angle value. Industry vocabulary first,
 * universal only as a fallback — an industry hit is the same-vocabulary match
 * and must never be added to a universal one for the same ads.
 */
export function ownAngleAdCount(
  mix: OwnAdAngleMix | null,
  value: string,
): number {
  if (!mix) return 0;
  const token = normalizeAngleToken(value);
  return mix.byAngle[token] ?? mix.byUniversal[token] ?? 0;
}

/** Share of the brand's labeled ads carrying this angle, rounded for display. */
export function ownAngleSharePct(
  mix: OwnAdAngleMix | null,
  value: string,
): number {
  if (!mix || mix.totalLabeledAds === 0) return 0;
  return Math.round((ownAngleAdCount(mix, value) / mix.totalLabeledAds) * 100);
}

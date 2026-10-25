import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrandContextRow } from '@/lib/creative-engine/brand-context/types';
import { checkA4Rows, readA4Tables } from './check';
import { segmentIdFor } from './facts';
import type { Stdb } from './spacetime';
import type { ClientBrand, Recipe, Segment } from './types';

/*
 * The pipeline's one input adapter. Until A4's rows land it runs on stand-ins
 * (dry: upsert_creatives rejects a creative whose brand, segment or arm doesn't
 * exist); after, on A4's brand, segment and arm rows and B's products. Nothing
 * downstream knows which source it got.
 */

export type InputSource = 'standin' | 'spacetime';

export interface CreativeInputs {
  source: InputSource;
  brand: ClientBrand;
  segments: Segment[];
  /** Non-control recipes only. */
  recipes: Recipe[];
  /** The control arm (Magic Spoon's live ads), which A5 never writes for. */
  controlArmId?: string;
  landingProductId: string;
  warnings: string[];
}

/** A4's rows aren't usable yet; `failures` lists every reason. */
export class NotReadyError extends Error {
  constructor(readonly failures: string[]) {
    super(`A4's rows are not ready:\n  ${failures.join('\n  ')}`);
    this.name = 'NotReadyError';
  }
}

/** A4's id for Magic Spoon (`br_` + slugify(name)), used only by the stand-in. */
const STAND_IN_BRAND: ClientBrand = { brand_id: 'br_magic_spoon', name: 'Magic Spoon' };

export function standInInputs(rows: BrandContextRow[]): CreativeInputs {
  const personas = rows.filter((row) => row.rowType === 'persona').sort((a, b) => (a.rowId < b.rowId ? -1 : 1));
  const recipes = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/arms.json'), 'utf8')) as Recipe[];
  return {
    source: 'standin',
    brand: STAND_IN_BRAND,
    // One segment per live persona fact, with ids already in A4's format.
    segments: personas.map((persona) => ({
      segment_id: segmentIdFor(persona.rowId),
      name: String(persona.content.name ?? persona.rowId),
      share: 1 / personas.length,
    })),
    recipes,
    landingProductId: '',
    warnings: ['stand-in rows: dry run only, landing_product_id is ""'],
  };
}

/** A4's rows, validated by the same check the `check` command prints. */
export async function spacetimeInputs(stdb: Stdb, rows: BrandContextRow[]): Promise<CreativeInputs> {
  const check = checkA4Rows(await readA4Tables(stdb), rows);
  if (check.failures.length > 0 || !check.brand) throw new NotReadyError(check.failures);
  return {
    source: 'spacetime',
    brand: check.brand,
    segments: check.segments,
    recipes: check.recipes,
    ...(check.controlArmId ? { controlArmId: check.controlArmId } : {}),
    landingProductId: check.landingProductId,
    warnings: check.warnings,
  };
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { ADLAB_ORG_ID } from './org';

/** The demo brand's site; A2's discover step keyed its profile on it. */
export const MAGIC_SPOON_URL = 'https://magicspoon.com/';

export interface BrandProfile {
  id: string;
  status: string;
  brand_name: string;
}

export async function loadBrandProfile(db: SupabaseClient): Promise<BrandProfile> {
  const { data, error } = await db
    .from('brand_presence_profiles')
    .select('id, status, brand_name')
    .eq('organization_id', ADLAB_ORG_ID)
    .eq('website_url', MAGIC_SPOON_URL)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No brand_presence_profiles row for ${MAGIC_SPOON_URL}: run npm run a2:ingest -- discover first`);
  return data as BrandProfile;
}

/** Every mention's title + body for the brand, by mention id. */
export async function loadMentionText(db: SupabaseClient, brandProfileId: string): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('brand_mentions')
      .select('id, title, body')
      .eq('organization_id', ADLAB_ORG_ID)
      .eq('brand_profile_id', brandProfileId)
      .order('id')
      .range(from, from + 999);
    if (error) throw error;
    for (const row of data ?? []) texts.set(String(row.id), [row.title, row.body].filter(Boolean).join('\n'));
    if ((data ?? []).length < 1000) return texts;
  }
}

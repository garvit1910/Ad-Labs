import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadLiveBrandFacts } from '@/lib/brand-object/live-facts';
import { BRAND_KIT_ID, IMAGE_FILE_RE, brandKitProblem } from '@/spacetime/src/agent_rules';
import { ADLAB_ORG_ID } from './org';
import type { Spacetime } from './spacetime-http';

/*
 * The brand kit (docs/PLAN.md "The contract", brand_kit): the onboarding step's brand URL and
 * product reference photo. The row lives in SpacetimeDB, so the agents and /agents share it; the
 * photo is a file next to the web app, in data/brand-kit/ (git-ignored, like data/ad-images/).
 */

export const BRAND_KIT_DIR = path.resolve('data/brand-kit');
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export interface BrandKit {
  brand_url: string;
  brand_name: string;
  image_file: string;
  image_sha: string;
  updated_at: string;
}

/** What Magic Spoon's onboarding already gathered, shown when the URL matches an onboarded brand. */
export interface OnFile {
  brand_name: string;
  facts: number;
  personas: number;
  mentions: number;
  ads: number;
  competitors: number;
}

/** A save the request can't satisfy (bad URL, wrong file type, too big): the route's 400. */
export class BrandKitInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandKitInputError';
  }
}

/** "https://www.MagicSpoon.com/shop" → "magicspoon.com"; null when it isn't a URL. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** A bare domain gets https://, so "magicspoon.com" is accepted the way people type it. */
export function normalizeBrandUrl(raw: string): string {
  const url = raw.trim();
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** The image's type from its first bytes, so a renamed file can't pass as an image. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  const at = (i: number, ...b: number[]) => b.every((v, j) => bytes[i + j] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  return null;
}

interface ProfileRow {
  id: string;
  brand_name: string;
  website_url: string;
}

/** The onboarded brand whose website shares the URL's host, if any. */
export async function matchProfile(db: SupabaseClient, url: string): Promise<ProfileRow | null> {
  const host = hostOf(url);
  if (!host) return null;
  const { data, error } = await db
    .from('brand_presence_profiles')
    .select('id, brand_name, website_url')
    .eq('organization_id', ADLAB_ORG_ID);
  if (error) throw error;
  return ((data ?? []) as ProfileRow[]).find((row) => hostOf(row.website_url) === host) ?? null;
}

async function countRows(db: SupabaseClient, table: string, filter: (q: any) => any): Promise<number> {
  const { count, error } = await filter(db.from(table).select('id', { count: 'exact', head: true }));
  if (error) throw error;
  return count ?? 0;
}

/** The counts behind the on-file summary: live facts, personas, mentions, ads and competitors. */
export async function onFileFor(db: SupabaseClient, profile: ProfileRow): Promise<OnFile> {
  const org = (q: any) => q.eq('organization_id', ADLAB_ORG_ID).eq('brand_profile_id', profile.id);
  const [facts, mentions, ads, competitors] = await Promise.all([
    loadLiveBrandFacts(db, { organizationId: ADLAB_ORG_ID, brandProfileId: profile.id }),
    countRows(db, 'brand_mentions', org),
    countRows(db, 'library_ads', (q) => q.eq('organization_id', ADLAB_ORG_ID)),
    countRows(db, 'tracked_competitors', (q) => org(q).eq('platform', 'meta').eq('is_brand_self', false)),
  ]);
  const personas = facts.filter((f) => f.section === 'persona').length;
  return { brand_name: profile.brand_name, facts: facts.length, personas, mentions, ads, competitors };
}

export async function getBrandKit(spacetime: Spacetime): Promise<BrandKit | null> {
  const rows = await spacetime.sql<BrandKit & { kit_id: string }>('SELECT * FROM brand_kit');
  const row = rows.find((r) => r.kit_id === BRAND_KIT_ID);
  return row
    ? { brand_url: row.brand_url, brand_name: row.brand_name, image_file: row.image_file, image_sha: row.image_sha, updated_at: String(row.updated_at) }
    : null;
}

/**
 * Saves the kit: checks the URL and the image (png, jpeg or webp by its bytes, at most 8 MB), writes
 * data/brand-kit/<sha12>.<ext>, matches the URL to an onboarded brand, then upserts the row.
 */
export async function saveBrandKit(
  deps: { spacetime: Spacetime; db: SupabaseClient; dir?: string },
  input: { url: string; bytes: Uint8Array },
): Promise<{ kit: BrandKit; on_file: OnFile | null }> {
  const brandUrl = normalizeBrandUrl(input.url);
  if (!hostOf(brandUrl)) throw new BrandKitInputError(`"${input.url}" is not a website address`);
  if (input.bytes.byteLength === 0) throw new BrandKitInputError('the product image is empty');
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) throw new BrandKitInputError(`the product image is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const ext = sniffImage(input.bytes);
  if (!ext) throw new BrandKitInputError('the product image must be a PNG, JPEG or WebP');

  const sha = createHash('sha256').update(input.bytes).digest('hex');
  const imageFile = `${sha.slice(0, 12)}.${ext}`;
  const profile = await matchProfile(deps.db, brandUrl);
  const row = { kit_id: BRAND_KIT_ID, brand_url: brandUrl, brand_name: profile?.brand_name ?? '', image_file: imageFile, image_sha: sha };
  const problem = brandKitProblem(row);
  if (problem) throw new BrandKitInputError(problem);

  const dir = deps.dir ?? BRAND_KIT_DIR;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, imageFile), input.bytes);
  await deps.spacetime.call('upsert_brand_kit', [row.kit_id, row.brand_url, row.brand_name, row.image_file, row.image_sha]);

  const kit = (await getBrandKit(deps.spacetime)) ?? { ...row, updated_at: new Date().toISOString() };
  return { kit, on_file: profile ? await onFileFor(deps.db, profile) : null };
}

/** The kit's photo, or null when the file name is bad or the file is gone. */
export async function readKitImage(imageFile: string, dir = BRAND_KIT_DIR): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!IMAGE_FILE_RE.test(imageFile)) return null;
  try {
    const bytes = await readFile(path.join(dir, imageFile));
    return { bytes, contentType: CONTENT_TYPE[imageFile.split('.').pop()!]! };
  } catch {
    return null;
  }
}

/**
 * The photo as a data: URL, the form the image provider's reference fetch accepts without a
 * network call (lib/creative-engine/generation/safe-image-fetch.ts).
 */
export async function kitImageDataUrl(kit: Pick<BrandKit, 'image_file'>, dir = BRAND_KIT_DIR): Promise<string | null> {
  const image = await readKitImage(kit.image_file, dir);
  return image ? `data:${image.contentType};base64,${image.bytes.toString('base64')}` : null;
}

/** Where a browser loads the photo. */
export const kitImagePath = (imageFile: string) => `/api/brand-kit/image/${imageFile}`;

/**
 * The photo's absolute URL for ASI:One cards, which can't load localhost: only when
 * ADLAB_PUBLIC_BASE_URL (a tunnel to this app) is set, else "".
 */
export function publicKitImageUrl(imageFile: string): string {
  const base = process.env.ADLAB_PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  return base ? `${base}${kitImagePath(imageFile)}` : '';
}

export interface BrandKitStatus {
  /** A row exists and its photo is on disk: the agents may start. */
  ready: boolean;
  /** Why not, or "". */
  reason: string;
  brand_url: string;
  brand_name: string;
  image_file: string;
  image_path: string;
  image_url: string;
  updated_at: string | null;
}

/** GET /api/agent/brand-kit (docs/AGENT_API.md): what the agents check before a run. */
export async function brandKitStatus(spacetime: Spacetime, dir = BRAND_KIT_DIR): Promise<BrandKitStatus> {
  const empty = { brand_url: '', brand_name: '', image_file: '', image_path: '', image_url: '', updated_at: null };
  let kit: BrandKit | null;
  try {
    kit = await getBrandKit(spacetime);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ready: false, reason: `no brand_kit table on ${spacetime.label} (${message.slice(0, 120)})`, ...empty };
  }
  if (!kit) return { ready: false, reason: 'no brand kit yet: set the brand URL and product photo at /start', ...empty };
  const onDisk = (await readKitImage(kit.image_file, dir)) !== null;
  return {
    ready: onDisk,
    reason: onDisk ? '' : `the product photo ${kit.image_file} is missing from data/brand-kit: upload it again at /start`,
    brand_url: kit.brand_url,
    brand_name: kit.brand_name,
    image_file: kit.image_file,
    image_path: kitImagePath(kit.image_file),
    image_url: publicKitImageUrl(kit.image_file),
    updated_at: kit.updated_at,
  };
}

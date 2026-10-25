import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrandKitInputError, brandKitStatus, hostOf, kitImageDataUrl, normalizeBrandUrl, saveBrandKit, sniffImage } from '../../../../lib/adlab/brand-kit';
import type { Spacetime } from '../../../../lib/adlab/spacetime-http';
import { fakeSupabase } from './fake-supabase';

// The brand kit (lib/adlab/brand-kit.ts): the onboarding step's URL and product photo.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeSpacetime() {
  const rows: Record<string, unknown>[] = [];
  const calls: unknown[][] = [];
  const st: Spacetime = {
    label: 'fake',
    async call(reducer, args) {
      assert.equal(reducer, 'upsert_brand_kit');
      calls.push(args);
      const [kit_id, brand_url, brand_name, image_file, image_sha] = args as string[];
      rows.splice(0, rows.length, { kit_id, brand_url, brand_name, image_file, image_sha, updated_at: '2026-10-25T12:00:00.000Z' });
    },
    async sql<T>() {
      return rows as T[];
    },
  };
  return { st, calls };
}

describe('brand kit helpers', () => {
  it('reads the host the way people type a site', () => {
    assert.equal(hostOf('https://www.MagicSpoon.com/shop'), 'magicspoon.com');
    assert.equal(hostOf('not a url'), null);
    assert.equal(normalizeBrandUrl(' magicspoon.com '), 'https://magicspoon.com');
    assert.equal(normalizeBrandUrl('http://x.co/'), 'http://x.co/');
  });

  it('tells images apart by their bytes', () => {
    assert.equal(sniffImage(PNG), 'png');
    assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
    assert.equal(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
    assert.equal(sniffImage(new TextEncoder().encode('<svg></svg>')), null);
  });
});

describe('saveBrandKit and brandKitStatus', () => {
  it('writes the photo and the row, and reports ready', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brand-kit-'));
    const { st, calls } = fakeSpacetime();
    const { db } = fakeSupabase({ brand_presence_profiles: [] });
    const saved = await saveBrandKit({ spacetime: st, db, dir }, { url: 'magicspoon.com', bytes: PNG });
    assert.equal(saved.kit.brand_url, 'https://magicspoon.com');
    assert.match(saved.kit.image_file, /^[0-9a-f]{12}\.png$/);
    assert.deepEqual([...readFileSync(path.join(dir, saved.kit.image_file))], [...PNG]);
    assert.equal(calls.length, 1);
    assert.equal(saved.on_file, null); // no onboarded profile in this fake

    const status = await brandKitStatus(st, dir);
    assert.equal(status.ready, true);
    assert.equal(status.image_path, `/api/brand-kit/image/${saved.kit.image_file}`);
    assert.match((await kitImageDataUrl(saved.kit, dir)) ?? '', /^data:image\/png;base64,/);
  });

  it('refuses a non-image or a bad URL before writing anything', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brand-kit-'));
    const { st, calls } = fakeSpacetime();
    const { db } = fakeSupabase({});
    await assert.rejects(saveBrandKit({ spacetime: st, db, dir }, { url: 'magicspoon.com', bytes: new TextEncoder().encode('<svg/>') }), BrandKitInputError);
    await assert.rejects(saveBrandKit({ spacetime: st, db, dir }, { url: 'https://', bytes: PNG }), BrandKitInputError);
    assert.equal(calls.length, 0);
  });

  it('is not ready without a row, or when the photo is gone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brand-kit-'));
    const { st } = fakeSpacetime();
    assert.equal((await brandKitStatus(st, dir)).ready, false);
    await st.call('upsert_brand_kit', ['kit_default', 'https://magicspoon.com/', '', 'ab12cd34ef56.png', 'ab12cd34ef56'.padEnd(64, '0')]);
    const status = await brandKitStatus(st, dir);
    assert.equal(status.ready, false);
    assert.match(status.reason, /missing/);
  });
});

/**
 * Ad Lab same-path stub for Adcero's R2 service (REUSE_MANIFEST §8.2).
 *
 * Objects live on local disk under `data/r2/<bucket>/<key>`. `downloadFile`
 * returns the real bytes: the brand-object identity step reads back the pages
 * the crawl step uploaded.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const R2_ROOT = path.resolve('data/r2');

function objectPath(bucket: string, key: string): string {
  const root = path.join(R2_ROOT, bucket);
  const file = path.resolve(root, key);
  if (!file.startsWith(root + path.sep)) {
    throw new Error(`r2 stub: key escapes bucket ${bucket}: ${key}`);
  }
  return file;
}

export const r2Service = {
  async uploadFile(
    bucket: string,
    key: string,
    body: Buffer | Uint8Array | string,
    _contentType?: string,
    _metadata?: Record<string, string>,
  ): Promise<{ bucket: string; key: string }> {
    const file = objectPath(bucket, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return { bucket, key };
  },

  async downloadFile(
    bucket: string,
    key: string,
  ): Promise<{ transformToString(): Promise<string>; transformToByteArray(): Promise<Uint8Array> }> {
    const bytes = await readFile(objectPath(bucket, key));
    return {
      transformToString: async () => bytes.toString('utf8'),
      transformToByteArray: async () => new Uint8Array(bytes),
    };
  },

  async fileExists(bucket: string, key: string): Promise<boolean> {
    try {
      await access(objectPath(bucket, key));
      return true;
    } catch {
      return false;
    }
  },

  getPublicUrl(bucket: string, key: string): string {
    return pathToFileURL(objectPath(bucket, key)).href;
  },
};

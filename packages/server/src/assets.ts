/** Uploaded images, fonts and rendered exports. */

import { newId } from '@playground/shared';
import { persistence } from './persistence.ts';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif',
  'video/mp4', 'video/webm',
  'font/woff2', 'font/woff', 'font/ttf', 'font/otf',
  'text/html', 'text/plain', 'application/json',
  // Code-component bundles. These are only ever executed inside a sandboxed
  // iframe without allow-same-origin, so they run with an opaque origin and
  // cannot reach the document, the parent page, cookies or storage.
  'text/javascript',
]);

export class AssetError extends Error {}

export async function storeAsset(
  docId: string | null,
  mime: string,
  name: string,
  bytes: Buffer,
): Promise<string> {
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new AssetError(`Asset is ${(bytes.length / 1e6).toFixed(1)}MB; the limit is ${MAX_ASSET_BYTES / 1e6}MB.`);
  }
  if (!ALLOWED_MIME.has(mime)) {
    throw new AssetError(`Unsupported type "${mime}". Allowed: ${[...ALLOWED_MIME].join(', ')}`);
  }
  const id = newId('a');
  const store = await persistence();
  await store.saveAsset({ id, docId, mime, name, bytes, createdAt: Date.now() });
  return id;
}

export async function getAsset(id: string) {
  const store = await persistence();
  return store.loadAsset(id);
}

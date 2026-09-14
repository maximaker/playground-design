/** Uploaded images, fonts and rendered exports. Stored in SQLite to keep the server single-file. */

import { newId } from '@canvas/shared';
import { db, now } from './db.ts';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif',
  'video/mp4', 'video/webm',
  'font/woff2', 'font/woff', 'font/ttf', 'font/otf',
  'text/html', 'text/plain', 'application/json',
]);

export class AssetError extends Error {}

export function storeAsset(docId: string | null, mime: string, name: string, bytes: Buffer): string {
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new AssetError(`Asset is ${(bytes.length / 1e6).toFixed(1)}MB; the limit is ${MAX_ASSET_BYTES / 1e6}MB.`);
  }
  if (!ALLOWED_MIME.has(mime)) {
    throw new AssetError(`Unsupported type "${mime}". Allowed: ${[...ALLOWED_MIME].join(', ')}`);
  }
  const id = newId('a');
  db.prepare('INSERT INTO assets (id, doc_id, mime, name, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, docId, mime, name, bytes, now());
  return id;
}

export function getAsset(id: string): { mime: string; name: string | null; bytes: Buffer } | null {
  const row = db.prepare('SELECT mime, name, bytes FROM assets WHERE id = ?').get(id) as
    { mime: string; name: string | null; bytes: Uint8Array } | undefined;
  if (!row) return null;
  return { mime: row.mime, name: row.name, bytes: Buffer.from(row.bytes) };
}

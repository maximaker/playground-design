/**
 * Copies an image from a link into a document's own assets.
 *
 * Figma's clipboard carries signed links to its images (they expire in about a
 * week), so a Figma paste imports each one here instead of pointing at Figma.
 * Only HTTPS links on Figma's image hosts are fetched: a fixed allowlist rather
 * than "any public URL", so this can never be turned on the server's network.
 */
import { storeAsset, MAX_ASSET_BYTES } from './assets.ts';

const ALLOWED_HOSTS = [/^s3-alpha(-sig)?\.figma\.com$/, /^figma-alpha-api\.s3\.[a-z0-9-]+\.amazonaws\.com$/];
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/;

export class ImageImportError extends Error {}

export function canImportImage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export async function importImage(docId: string, url: string, name = 'image'): Promise<{ id: string; mime: string; size: number }> {
  if (!canImportImage(url)) throw new ImageImportError('Only Figma image links can be imported.');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new ImageImportError(`The image link answered ${res.status}${res.status === 403 ? ' (it may have expired; copy again in Figma)' : ''}.`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_ASSET_BYTES) throw new ImageImportError('The image is larger than 25MB.');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_ASSET_BYTES) throw new ImageImportError('The image is larger than 25MB.');
  // Figma serves images without a reliable type, so sniff the common ones.
  const mime = sniff(bytes) ?? res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!IMAGE_TYPES.test(mime)) throw new ImageImportError('That link is not an image.');
  const ext = mime.split('/')[1]!.replace('svg+xml', 'svg').replace('jpeg', 'jpg');
  const id = await storeAsset(docId, mime, `${name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'image'}.${ext}`, bytes);
  return { id, mime, size: bytes.length };
}

function sniff(b: Buffer): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 4).toString() === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/^\s*(<\?xml|<svg)/.test(b.subarray(0, 100).toString())) return 'image/svg+xml';
  return null;
}

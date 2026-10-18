/**
 * Copies an image from a link into a document's own assets.
 *
 * Figma's clipboard carries signed links to its images (they expire in about a
 * week), so a Figma paste imports each one here instead of pointing at Figma.
 * Agents use the same path for any public image (a CDN, Unsplash, a site).
 *
 * Any https host is allowed, so the guard is on the address, not the name:
 * every connection, including each redirect hop, resolves the host and refuses
 * private, loopback, link-local and other internal ranges at connect time. That
 * check sits in the socket's own lookup, so a name that resolves publicly once
 * and privately the next time (DNS rebinding) still cannot reach the server's
 * network.
 */
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import { storeAsset, MAX_ASSET_BYTES } from './assets.ts';

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;

export class ImageImportError extends Error {}

export function canImportImage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

/** True for any address that is not on the public internet. Names are false: they are checked once resolved. */
export function isPrivateAddress(host: string): boolean {
  const kind = net.isIP(host);
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (kind === 6) {
    const h = host.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateAddress(mapped[1]!);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (hex) {
      const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h) || h.startsWith('64:ff9b:');
  }
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local');
}

const safeLookup: typeof dns.lookup = ((hostname: string, options: dns.LookupOptions, callback: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new ImageImportError('That link points to a private address.'), '', 0);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}) as typeof dns.lookup;

function get(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { lookup: safeLookup, timeout: TIMEOUT_MS, headers: { 'User-Agent': 'Playground image import', Accept: 'image/*' } }, resolve);
    req.on('timeout', () => req.destroy(new ImageImportError('The image link took too long to answer.')));
    req.on('error', reject);
  });
}

async function download(url: string): Promise<{ bytes: Buffer; type: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!canImportImage(current)) throw new ImageImportError('Only public https image links can be imported.');
    const res = await get(current);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new ImageImportError(`The image link answered ${status}${status === 403 ? ' (it may have expired; a Figma link lasts about a week)' : ''}.`);
    }
    if (Number(res.headers['content-length'] ?? 0) > MAX_ASSET_BYTES) {
      res.destroy();
      throw new ImageImportError('The image is larger than 25MB.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res) {
      size += (chunk as Buffer).length;
      if (size > MAX_ASSET_BYTES) { res.destroy(); throw new ImageImportError('The image is larger than 25MB.'); }
      chunks.push(chunk as Buffer);
    }
    return { bytes: Buffer.concat(chunks), type: String(res.headers['content-type'] ?? '') };
  }
  throw new ImageImportError('The image link redirected too many times.');
}

export async function importImage(docId: string, url: string, name = 'image'): Promise<{ id: string; mime: string; size: number }> {
  let got: { bytes: Buffer; type: string };
  try {
    got = await download(url);
  } catch (err) {
    if (err instanceof ImageImportError) throw err;
    throw new ImageImportError(`Could not fetch the image: ${(err as Error).message}`);
  }
  const { bytes } = got;
  // Figma and some CDNs serve images without a reliable type, so sniff the common ones.
  const mime = sniff(bytes) ?? got.type.split(';')[0]?.trim() ?? '';
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

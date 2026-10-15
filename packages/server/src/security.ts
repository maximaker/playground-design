/**
 * Request hardening shared by every route: per-IP rate limits on public
 * writes, security headers, and upload content checks.
 *
 * Kept in one dependency-free module so it can be tested without a server and
 * so a route added later has one obvious place to opt into.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

// ---------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------

/**
 * The caller's address: Cloudflare's header first, then the first hop of
 * X-Forwarded-For (what Coolify's proxy sets), then the socket. Null when none
 * can be determined.
 */
export function clientIp(c: Context): string | null {
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  /** Bucket name; limits with different names never share a count. */
  name: string;
  /** Requests allowed per window per IP. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Only these methods count; default POST. */
  methods?: string[];
}

interface Window { start: number; count: number }

/**
 * Fixed-window, in-memory, per-IP limiter. One process, so it resets on a
 * redeploy and is not shared between replicas — enough to blunt brute force
 * and floods on a single-container deploy, not a substitute for an edge WAF.
 *
 * A request straight from loopback with no proxy header is the local test
 * suite or a health check, and is not counted.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler & { reset(): void } {
  const hits = new Map<string, Window>();
  const methods = new Set((opts.methods ?? ['POST']).map((m) => m.toUpperCase()));
  let lastSweep = Date.now();

  const handler: MiddlewareHandler = async (c, next) => {
    if (!methods.has(c.req.method.toUpperCase())) return next();
    const proxied = !!(c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for'));
    const ip = clientIp(c) ?? 'unknown';
    if (!proxied && LOOPBACK.has(ip)) return next();

    const now = Date.now();
    // Drop stale windows now and then so the map cannot grow without bound.
    if (now - lastSweep > opts.windowMs) {
      for (const [k, w] of hits) if (now - w.start >= opts.windowMs) hits.delete(k);
      lastSweep = now;
    }
    let w = hits.get(ip);
    if (!w || now - w.start >= opts.windowMs) {
      w = { start: now, count: 0 };
      hits.set(ip, w);
    }
    w.count++;
    if (w.count > opts.limit) {
      const retry = Math.max(1, Math.ceil((w.start + opts.windowMs - now) / 1000));
      return c.json({ error: 'Too many requests. Try again shortly.' }, 429, { 'Retry-After': String(retry) });
    }
    return next();
  };
  return Object.assign(handler, { reset: () => hits.clear() });
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

/**
 * CSP for the editor shell and the API.
 *
 * Code components run in a sandboxed srcdoc frame that inherits this policy
 * and imports their bundle from a blob with an inline module, hence
 * 'unsafe-inline' and blob: for scripts. Designs reference images, fonts and
 * stylesheets from anywhere, so those stay open; what is closed is plugins,
 * <base> hijacking, foreign form targets and being framed by other sites.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src * data: blob:",
  "media-src * data: blob:",
  "connect-src 'self' ws: wss: https:",
  "frame-src 'self' blob: data: https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://*.heymax.im https://*.thedigitalvitamins.com",
].join('; ');

/**
 * Published pages and handoff sites: user-authored markup with no scripts of
 * their own, so nothing may run. Still embeddable anywhere.
 */
export const PUBLISHED_CSP = [
  "script-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Uploaded files: if one is ever opened as a document (an SVG or HTML asset in
 * a new tab), it runs in a unique opaque origin with no scripts, so it cannot
 * act as the signed-in user. Fetching or <img>-loading the asset is unaffected.
 */
export const ASSET_CSP = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

export function cspFor(path: string): string {
  if (path.startsWith('/assets/') && !path.startsWith('/assets/app/')) return ASSET_CSP;
  if (path.startsWith('/p/') || path.startsWith('/h/')) return PUBLISHED_CSP;
  return APP_CSP;
}

/** Sets the baseline headers on every response unless a route set its own. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  const set = (k: string, v: string) => { if (!h.has(k)) h.set(k, v); };
  set('X-Content-Type-Options', 'nosniff');
  set('Referrer-Policy', 'strict-origin-when-cross-origin');
  set('Permissions-Policy', PERMISSIONS_POLICY);
  set('Content-Security-Policy', cspFor(c.req.path));
};

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** Per-type ceilings, tighter than the global one where a type has no need of it. */
export const MAX_BYTES_BY_PREFIX: [string, number][] = [
  ['image/svg+xml', 2 * 1024 * 1024],
  ['image/', 15 * 1024 * 1024],
  ['font/', 5 * 1024 * 1024],
  ['text/', 5 * 1024 * 1024],
  ['application/json', 5 * 1024 * 1024],
  ['video/', 25 * 1024 * 1024],
];

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/avif': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'video/mp4': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'video/webm': (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  'font/woff2': (b) => b.subarray(0, 4).toString('latin1') === 'wOF2',
  'font/woff': (b) => b.subarray(0, 4).toString('latin1') === 'wOFF',
};

/**
 * Why these bytes may not be stored under this type, or null when they may.
 * Binary types must start with their real signature, so a page cannot be
 * uploaded as "image/png" and later served as something else.
 */
export function uploadProblem(mime: string, bytes: Buffer): string | null {
  const ceiling = MAX_BYTES_BY_PREFIX.find(([p]) => mime.startsWith(p))?.[1];
  if (ceiling !== undefined && bytes.length > ceiling) {
    return `A ${mime} file may be at most ${ceiling / (1024 * 1024)}MB.`;
  }
  const check = MAGIC[mime];
  if (check && !check(bytes)) return `The file is not a valid ${mime}.`;
  return null;
}

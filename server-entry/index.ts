/**
 * Vercel entry point.
 *
 * Bundled to `api/index.js` at build time by `scripts/build-api.mjs`: Vercel's
 * Node builder transpiles the entry file but will not follow `.ts` imports into
 * a workspace package, so the whole server has to arrive as one file.
 *
 * Routing is explicit. A rewrite to a function replaces the request path with
 * the destination, and Vercel's catch-all convention only matched the first
 * path segment here — so `vercel.json` carries the original path in `__path`
 * and this handler puts it back. It is more literal than relying on framework
 * conventions, and it is verifiable.
 *
 * The same Hono app runs here and in the long-lived Node server; only what is
 * underneath it changes. On Vercel there is no filesystem, so persistence goes
 * to Blob, and no WebSocket support, so clients fall back to HTTP polling.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../packages/server/src/app.ts';

export const config = { runtime: 'nodejs' };

/**
 * Adapts Vercel's Node handler signature to the app's web-standard fetch.
 *
 * The generic Node adapters do not work here: Vercel parses a JSON request body
 * before invoking the function and leaves `req` already consumed, so building a
 * Request from the stream waits forever on a body that will never arrive. Every
 * POST timed out while GETs were fine. Reading `req.body` when the platform has
 * populated it is what fixes that.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const request = await toRequest(req);
    const response = await app.fetch(request);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (err) {
    console.error('[playground] request failed', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
    }
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }));
  }
}

/** Query parameter carrying the original path through the rewrite. */
const PATH_PARAM = '__path';

async function toRequest(req: IncomingMessage): Promise<Request> {
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  const url = new URL(req.url ?? '/', `${proto}://${host}`);

  const original = url.searchParams.get(PATH_PARAM);
  if (original) {
    url.searchParams.delete(PATH_PARAM);
    // Keep the rest of the query string, which Vercel appends after ours.
    url.pathname = original.startsWith('/') ? original : `/${original}`;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }

  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });

  return new Request(url, { method, headers, body: await readBody(req) });
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  // Vercel may have parsed and attached the body already.
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined && parsed !== null) {
    if (Buffer.isBuffer(parsed)) return parsed;
    if (typeof parsed === 'string') return Buffer.from(parsed);
    return Buffer.from(JSON.stringify(parsed));
  }

  if (req.readableEnded) return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

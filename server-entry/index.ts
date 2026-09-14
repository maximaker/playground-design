/**
 * Vercel entry point.
 *
 * Bundled to `api/[...path].js` at build time by `scripts/build-api.mjs`:
 * Vercel's Node builder transpiles the entry file but will not follow `.ts`
 * imports into a workspace package, so the whole server has to arrive as one
 * file. The catch-all name matters too — a rewrite to a plain `api/index` hands
 * the function the destination path, losing the route the client asked for.
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

async function toRequest(req: IncomingMessage): Promise<Request> {
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  const url = new URL(req.url ?? '/', `${proto}://${host}`);

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

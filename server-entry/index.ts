/**
 * Vercel entry point.
 *
 * Bundled to `api/index.js` at build time by `scripts/build-api.mjs`. Vercel's
 * Node builder transpiles the entry file but does not follow `.ts` imports into
 * a workspace, so the whole server has to arrive as one file.
 *
 * The same Hono app runs here and in the long-lived Node server; only what is
 * underneath it changes. On Vercel there is no filesystem, so persistence goes
 * to Blob, and no WebSocket support, so clients fall back to HTTP polling.
 */

import { app } from '../packages/server/src/app.ts';

export const config = { runtime: 'nodejs' };

export default function handler(request: Request): Response | Promise<Response> {
  return app.fetch(request);
}

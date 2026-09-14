/**
 * Vercel entry point.
 *
 * Bundled to `api/[...path].js` at build time by `scripts/build-api.mjs`:
 * Vercel's Node builder transpiles the entry file but will not follow `.ts`
 * imports into a workspace package, so the whole server has to arrive as one
 * file. The catch-all name matters too — a plain `api/index` receives the
 * rewritten destination path, losing the route the client actually asked for.
 *
 * The same Hono app runs here and in the long-lived Node server; only what is
 * underneath it changes. On Vercel there is no filesystem, so persistence goes
 * to Blob, and no WebSocket support, so clients fall back to HTTP polling.
 */

import { getRequestListener } from '@hono/node-server';
import { app } from '../packages/server/src/app.ts';

export const config = { runtime: 'nodejs' };

// Vercel's Node runtime invokes handlers with (IncomingMessage, ServerResponse);
// this adapts the app's web-standard fetch to that signature.
export default getRequestListener(app.fetch);

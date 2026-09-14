/**
 * Server entry point. Starts the HTTP listener, attaches the realtime
 * WebSocket, seeds a starter document, and handles shutdown.
 */

import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { createEmptyDocument } from '@playground/shared';
import { app, PORT, PUBLIC_URL, WEB_DIST } from './app.ts';
import { attachRealtime } from './realtime.ts';
import { createDocument, listDocuments, flushAll } from './store.ts';
import { shutdownRenderer } from './render.ts';

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\n  Canvas server  \u2192  http://localhost:${info.port}`);
  console.log(`  MCP endpoint   \u2192  ${PUBLIC_URL}/mcp/<connection-code>`);
  console.log(`  Web client     \u2192  ${existsSync(WEB_DIST) ? PUBLIC_URL : 'http://localhost:5173 (vite dev)'}\n`);
});

attachRealtime(server as unknown as Server);

// Seed one document so a fresh clone has somewhere to land.
if ((await listDocuments()).length === 0) {
  const doc = createEmptyDocument('Welcome to Playground');
  await createDocument('Welcome to Playground', doc);
  console.log(`  Seeded a starter document: ${PUBLIC_URL}/d/${doc.id}\n`);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void flushAll().finally(() => shutdownRenderer().finally(() => process.exit(0)));
  });
}

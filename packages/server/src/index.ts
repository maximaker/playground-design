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
import { persistence } from './persistence.ts';
import { DB_PATH } from './persistence-sqlite.ts';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Whether a path sits on a mounted volume rather than the container's own
 * filesystem. Returns null where it cannot tell, which is anywhere without
 * /proc — development machines, mostly.
 *
 * This exists because the failure it catches is silent and expensive. A
 * container without an attached volume still writes happily; the data is simply
 * discarded the next time the container is replaced, and the only symptom is an
 * empty database after a deploy. Worse, `VOLUME` in a Dockerfile creates an
 * anonymous volume, so the data survives a *restart* — which makes it look
 * persistent right up until the first real redeploy destroys it.
 */
function isOnMountedVolume(path: string): boolean | null {
  let mounts: string[];
  try {
    mounts = readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n').map((line) => line.split(' ')[4]).filter((p): p is string => !!p);
  } catch {
    return null;
  }
  // Walk up to the nearest mount point. If that is the root filesystem, the
  // path is in the container layer and will not survive.
  let dir = resolve(path);
  for (;;) {
    if (mounts.includes(dir)) return dir !== '/';
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

const store = await persistence();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\n  Playground     \u2192  http://localhost:${info.port}`);
  console.log(`  MCP endpoint   \u2192  ${PUBLIC_URL}/mcp/<connection-code>`);
  console.log(`  Web client     \u2192  ${existsSync(WEB_DIST) ? PUBLIC_URL : 'http://localhost:5173 (vite dev)'}`);
  // Printed because on a container this is the only way to confirm the volume
  // was actually mounted. A missing mount is silent: writes succeed, and the
  // data is thrown away on the next deploy.
  console.log(`  Storage        \u2192  ${store.kind}${store.kind === 'sqlite' ? ` at ${DB_PATH}` : ''}`);
  const onVolume = store.kind === 'sqlite' ? isOnMountedVolume(dirname(DB_PATH)) : null;
  if (onVolume === false) {
    console.log('\n  ! The database is on the container filesystem, not a mounted volume.');
    console.log(`    Everything will be lost the next time this container is replaced.`);
    console.log(`    Attach a volume at ${dirname(DB_PATH)}, or point PLAYGROUND_DB at one.`);
  }
  if (PUBLIC_URL.includes('localhost') && process.env.NODE_ENV === 'production') {
    console.log('\n  ! PLAYGROUND_PUBLIC_URL is not set, so connection codes and share');
    console.log('    links will point at localhost and fail on anyone else\'s machine.');
  }
  console.log('');
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

/**
 * The Hono application: REST API, asset serving, MCP endpoint, static client.
 *
 * Deliberately free of side effects so tests can mount it on their own port —
 * starting a listener lives in index.ts.
 */

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emitHtml, emitJsx, emitStandalone, parseHtml,
  type CanvasDocument, getNode,
} from '@canvas/shared';
import {
  applyOps, createDocument, deleteDocument, getDocument, history, listDocuments,
  createSnapshot, listSnapshots, restoreSnapshot, StoreError,
} from './store.ts';
import { peersOf, hasLiveTab } from './realtime.ts';
import { createConnection, listConnections, resolveConnection, revokeConnection } from './connections.ts';
import { handleMcpRequest } from './mcp.ts';
import { getAsset, storeAsset, AssetError, MAX_ASSET_BYTES } from './assets.ts';
import { renderNode } from './render.ts';

const PORT = Number(process.env.PORT ?? 4000);
const PUBLIC_URL = process.env.CANVAS_PUBLIC_URL ?? `http://localhost:${PORT}`;

const app = new Hono();

app.use('*', cors({ origin: (o) => o ?? '*', credentials: true }));

app.onError((err, c) => {
  if (err instanceof StoreError) return c.json({ error: err.message }, 409);
  if (err instanceof AssetError) return c.json({ error: err.message }, 413);
  console.error('[canvas]', err);
  return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const api = new Hono();

api.get('/health', (c) => c.json({ ok: true, version: '0.1.0' }));

api.get('/documents', (c) => c.json({ documents: listDocuments() }));

api.post('/documents', async (c) => {
  const body = await c.req.json<{ name?: string; html?: string }>().catch(() => ({} as { name?: string; html?: string }));
  const doc = createDocument(body.name?.trim() || 'Untitled');

  // Seeding from HTML at creation time is what makes fully headless agent
  // sessions practical: create a document with content in one call.
  if (body.html) {
    const parsed = parseHtml(body.html);
    if (parsed.nodes.length) {
      const artboard = doc.pages[0]!.artboards[0]!;
      applyOps(doc.id, [{
        op: { t: 'insert', nodes: parsed.nodes, parent: artboard, index: 0 },
        origin: { kind: 'system', id: 'seed' },
      }]);
    }
  }
  return c.json({ document: getDocument(doc.id), url: `${PUBLIC_URL}/d/${doc.id}` }, 201);
});

api.get('/documents/:id', (c) => {
  const doc = getDocument(c.req.param('id'));
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json({ document: doc, peers: peersOf(doc.id), liveTabConnected: hasLiveTab(doc.id) });
});

api.delete('/documents/:id', (c) =>
  deleteDocument(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404));

api.post('/documents/:id/ops', async (c) => {
  const doc = requireDocument(c.req.param('id'));
  const body = await c.req.json<{ ops: Parameters<typeof applyOps>[1] }>();
  const applied = applyOps(doc.id, body.ops);
  return c.json({ rev: doc.rev, applied: applied.length });
});

api.get('/documents/:id/history', (c) =>
  c.json({ history: history(requireDocument(c.req.param('id')).id) }));

api.get('/documents/:id/snapshots', (c) =>
  c.json({ snapshots: listSnapshots(requireDocument(c.req.param('id')).id) }));

api.post('/documents/:id/snapshots', async (c) => {
  const doc = requireDocument(c.req.param('id'));
  const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
  return c.json(createSnapshot(doc.id, body.label), 201);
});

api.post('/documents/:id/snapshots/:snapshotId/restore', (c) => {
  const doc = requireDocument(c.req.param('id'));
  return c.json({ document: restoreSnapshot(doc.id, c.req.param('snapshotId')) });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

api.get('/documents/:id/export/:nodeId', async (c) => {
  const doc = requireDocument(c.req.param('id'));
  const nodeId = c.req.param('nodeId');
  if (!getNode(doc, nodeId)) return c.json({ error: `node ${nodeId} not found` }, 404);

  const format = (c.req.query('format') ?? 'html') as string;
  const scale = Number(c.req.query('scale') ?? 2);

  if (format === 'jsx') {
    const code = emitJsx(doc, nodeId, {
      format: (c.req.query('jsxFormat') as 'tailwind' | 'inline') ?? 'tailwind',
      componentName: c.req.query('componentName') ?? undefined,
    });
    return c.text(code, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (format === 'css') {
    const { css } = emitHtml(doc, nodeId, { mode: 'stylesheet' });
    return c.text(css, 200, { 'Content-Type': 'text/css; charset=utf-8' });
  }
  if (format === 'html') {
    return c.html(emitStandalone(doc, nodeId));
  }

  const { data, mime } = await renderNode(doc, nodeId, {
    format: format as 'png' | 'jpg' | 'webp' | 'svg', scale, baseUrl: PUBLIC_URL,
  });
  const name = (getNode(doc, nodeId)?.name ?? 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return c.body(new Uint8Array(data), 200, {
    'Content-Type': mime,
    'Content-Disposition': `attachment; filename="${name}.${format}"`,
  });
});

// ---------------------------------------------------------------------------
// Agent connections
// ---------------------------------------------------------------------------

api.get('/documents/:id/connections', (c) =>
  c.json({ connections: listConnections(requireDocument(c.req.param('id')).id) }));

api.post('/documents/:id/connections', async (c) => {
  const doc = requireDocument(c.req.param('id'));
  const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
  const conn = createConnection(doc.id, body.label);
  const url = `${PUBLIC_URL}/mcp/${conn.code}`;
  return c.json({
    connection: conn,
    url,
    setup: {
      claudeCode: `claude mcp add canvas --transport http ${url}`,
      claudeDesktop: {
        mcpServers: { canvas: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
      },
      cursor: { mcpServers: { canvas: { url } } },
      vscode: { servers: { canvas: { type: 'http', url } } },
    },
    expiresIn: 'The code stops working if unused for 30 minutes before its first connection.',
  }, 201);
});

api.delete('/connections/:code', (c) =>
  revokeConnection(c.req.param('code')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404));

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

api.post('/documents/:id/assets', async (c) => {
  const doc = requireDocument(c.req.param('id'));
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'expected a "file" field' }, 400);
  if (file.size > MAX_ASSET_BYTES) return c.json({ error: `file exceeds ${MAX_ASSET_BYTES / 1e6}MB` }, 413);

  const bytes = Buffer.from(await file.arrayBuffer());
  const id = storeAsset(doc.id, file.type || 'application/octet-stream', file.name, bytes);
  return c.json({ id, url: `${PUBLIC_URL}/assets/${id}`, name: file.name, size: bytes.length }, 201);
});

app.route('/api', api);

app.get('/assets/:id', (c) => {
  const asset = getAsset(c.req.param('id'));
  if (!asset) return c.json({ error: 'not found' }, 404);
  return c.body(new Uint8Array(asset.bytes), 200, {
    'Content-Type': asset.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

app.all('/mcp/:code', async (c) => {
  const connection = resolveConnection(c.req.param('code'));
  if (!connection) {
    // Deliberately does not distinguish unknown / revoked / expired.
    return c.json({
      error: 'This connection code is not valid. Generate a new one from the Connect agent panel in Canvas.',
    }, 401);
  }
  return handleMcpRequest(c.req.raw, connection, PUBLIC_URL);
});

// ---------------------------------------------------------------------------
// Web client
// ---------------------------------------------------------------------------

// Anchored to this package, not the working directory, for the same reason the
// database path is: starting the server from elsewhere should not change what
// it serves.
const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const WEB_DIST = resolve(PACKAGE_ROOT, '../web/dist');
if (existsSync(WEB_DIST)) {
  // serveStatic resolves `root` against the process working directory, so hand
  // it a relative path computed from wherever the server was actually started.
  const relRoot = relative(process.cwd(), WEB_DIST) || '.';
  app.use('/assets/app/*', serveStatic({ root: relRoot }));
  app.use('/*', serveStatic({ root: relRoot }));
  // The editor is a SPA: every unmatched path serves the shell so /d/:id works
  // on a hard refresh.
  const shell = serveStatic({ path: `${relative(process.cwd(), WEB_DIST) || '.'}/index.html` });
  app.get('/d/:id', shell);
  app.notFound((c) => shell(c, async () => {}) as Response | Promise<Response>);
} else {
  app.get('/', (c) =>
    c.text('Canvas API is running. The web client is not built — run `npm run dev:web` (Vite serves it on :5173).'));
}

function requireDocument(id: string): CanvasDocument {
  const doc = getDocument(id);
  if (!doc) throw new StoreError(`document ${id} not found`);
  return doc;
}

export { app, PORT, PUBLIC_URL, WEB_DIST };

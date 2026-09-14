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
  emitHtml, emitJsx, emitStandalone, parseHtml, makeNode,
  DEFAULT_ARTBOARD_STYLES, type CanvasDocument, getNode,
} from '@playground/shared';
import {
  applyOps, createDocument, deleteDocument, ensureLoaded, getDocument, history, listDocuments,
  createSnapshot, listSnapshots, opsSince, restoreSnapshot, StoreError,
} from './store.ts';
import { peersOf, hasLiveTab } from './realtime.ts';
import { createConnection, listConnections, resolveConnection, revokeConnection } from './connections.ts';
import { handleMcpRequest } from './mcp.ts';
import { getAsset, storeAsset, AssetError, MAX_ASSET_BYTES } from './assets.ts';
import { importUrl, ImportError } from './import.ts';
import { getTemplate, templateSummaries, type Template } from './templates.ts';
import { renderNode } from './render.ts';

const PORT = Number(process.env.PORT ?? 4000);
const PUBLIC_URL =
  process.env.PLAYGROUND_PUBLIC_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null) ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
  `http://localhost:${PORT}`;

/** On Vercel the platform serves the built client; the app only handles the API. */
const SERVE_CLIENT = !process.env.VERCEL;

const app = new Hono();

app.use('*', cors({ origin: (o) => o ?? '*', credentials: true }));

/**
 * On Vercel every route reaches the function under `/api`, because that is the
 * only path that maps to a serverless function. Strip the prefix for the routes
 * that are not part of the API, so their URLs stay the same in both shapes.
 */
if (!SERVE_CLIENT) {
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const alias = url.pathname.startsWith('/api/mcp/')
      ? url.pathname.slice(4)
      : url.pathname.startsWith('/api/assets/')
        ? url.pathname.slice(4)
        : null;
    if (!alias) return next();
    return app.fetch(new Request(new URL(alias + url.search, url.origin), c.req.raw));
  });
}

app.onError((err, c) => {
  if (err instanceof ImportError) return c.json({ error: err.message }, 422);
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

api.get('/documents', async (c) => c.json({ documents: await listDocuments() }));

api.get('/templates', (c) => c.json({ templates: templateSummaries() }));

api.post('/documents', async (c) => {
  const body = await c.req
    .json<{ name?: string; html?: string; template?: string }>()
    .catch(() => ({} as { name?: string; html?: string; template?: string }));

  const template = body.template ? getTemplate(body.template) : undefined;
  if (body.template && !template) {
    return c.json({ error: `No template "${body.template}". Available: ${templateSummaries().map((t) => t.id).join(', ')}` }, 400);
  }

  const doc = await createDocument(body.name?.trim() || template?.name || 'Untitled');
  // A brand new document has only the seeded defaults, and the kit is the whole
  // point of choosing it — so it replaces them outright rather than losing every
  // colour to a name collision.
  if (template) applyTemplate(doc.id, template, { replaceTokens: true });

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

api.post('/documents/:id/template', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ template: string; replaceTokens?: boolean }>();
  const template = getTemplate(body.template);
  if (!template) return c.json({ error: `No template "${body.template}"` }, 400);
  const result = applyTemplate(doc.id, template, { replaceTokens: body.replaceTokens === true });
  return c.json({ applied: template.id, ...result }, 201);
});

/**
 * Applies a starter kit.
 *
 * `replaceTokens` decides who wins a name collision. On a new document the kit
 * should win, or every colour it defines is shadowed by the seeded defaults and
 * the kit renders in the wrong palette. On an existing document the document
 * wins, because its tokens are real work.
 */
function applyTemplate(
  docId: string,
  template: Template,
  opts: { replaceTokens?: boolean } = {},
): { artboards: string[]; tokensAdded: string[]; tokensSkipped: string[] } {
  const doc = getDocument(docId)!;
  const page = doc.pages[0]!;

  const existing = new Map(doc.tokens.map((t) => [t.name, t]));
  const tokensAdded: string[] = [];
  const tokensSkipped: string[] = [];

  for (const token of template.tokens) {
    if (existing.has(token.name) && !opts.replaceTokens) { tokensSkipped.push(token.name); continue; }
    existing.set(token.name, token);
    tokensAdded.push(token.name);
  }

  applyOps(docId, [{ op: { t: 'tokens', tokens: [...existing.values()] }, origin: { kind: 'system', id: 'template' } }]);

  const created: string[] = [];
  for (const spec of template.artboards) {
    const artboard = makeNode({
      type: 'artboard',
      name: `${template.name} — ${spec.name}`,
      styles: { ...DEFAULT_ARTBOARD_STYLES, ...spec.styles, width: `${spec.width}px`, height: `${spec.height}px` },
      attrs: { 'data-x': String(nextX(getDocument(docId)!, page.artboards)), 'data-y': '0' },
    });
    applyOps(docId, [{
      op: { t: 'insert', nodes: [artboard], parent: null, index: page.artboards.length, page: page.id },
      origin: { kind: 'system', id: 'template' },
    }]);

    const parsed = parseHtml(spec.html);
    applyOps(docId, [{
      op: { t: 'insert', nodes: parsed.nodes, parent: artboard.id, index: 0 },
      origin: { kind: 'system', id: 'template', label: `${template.name} kit` },
    }]);
    created.push(artboard.id);
  }
  return { artboards: created, tokensAdded, tokensSkipped };
}

api.get('/documents/:id', async (c) => {
  await ensureLoaded(c.req.param('id'));
  const doc = getDocument(c.req.param('id'));
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json({ document: doc, peers: peersOf(doc.id), liveTabConnected: hasLiveTab(doc.id) });
});

/**
 * Polling transport, for runtimes without WebSockets (Vercel functions).
 * Returns the ops after `rev`, or the whole document when the caller is further
 * behind than the op log reaches.
 */
api.get('/documents/:id/sync', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const since = Number(c.req.query('rev') ?? 0);
  const ops = opsSince(doc.id, since);
  if (ops === null) return c.json({ resync: true, document: doc, rev: doc.rev });
  return c.json({ ops, rev: doc.rev, peers: peersOf(doc.id) });
});

api.delete('/documents/:id', async (c) =>
  (await deleteDocument(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404));

api.post('/documents/:id/ops', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ ops: Parameters<typeof applyOps>[1] }>();
  const applied = applyOps(doc.id, body.ops);
  return c.json({ rev: doc.rev, applied: applied.length });
});

api.get('/documents/:id/history', async (c) =>
  c.json({ history: history((await requireDocument(c.req.param('id'))).id) }));

api.get('/documents/:id/snapshots', async (c) =>
  c.json({ snapshots: await listSnapshots((await requireDocument(c.req.param('id'))).id) }));

api.post('/documents/:id/snapshots', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
  return c.json(await createSnapshot(doc.id, body.label), 201);
});

api.post('/documents/:id/snapshots/:snapshotId/restore', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  return c.json({ document: await restoreSnapshot(doc.id, c.req.param('snapshotId')) });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

api.get('/documents/:id/export/:nodeId', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
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

api.post('/documents/:id/import', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ url: string; artboardId?: string; pageId?: string }>();
  const result = await importUrl(body.url);

  const page = doc.pages.find((p) => p.id === body.pageId) ?? doc.pages[0]!;
  let artboardId = body.artboardId;

  if (!artboardId) {
    // A fresh artboard, sized to a desktop viewport, keeps the import from
    // landing inside unrelated work.
    const artboard = makeNode({
      type: 'artboard',
      name: result.title.slice(0, 40),
      styles: { ...DEFAULT_ARTBOARD_STYLES, width: '1440px', height: '1200px', overflow: 'hidden' },
      attrs: { 'data-x': String(nextX(doc, page.artboards)), 'data-y': '0' },
    });
    applyOps(doc.id, [{
      op: { t: 'insert', nodes: [artboard], parent: null, index: page.artboards.length, page: page.id },
      origin: { kind: 'system', id: 'import' },
    }]);
    artboardId = artboard.id;
  }

  applyOps(doc.id, [{
    op: { t: 'insert', nodes: result.nodes, parent: artboardId, index: 0 },
    origin: { kind: 'system', id: 'import', label: `Import ${result.url}` },
  }]);

  return c.json({
    artboardId,
    nodeCount: result.nodes.length,
    title: result.title,
    warnings: result.warnings,
  }, 201);
});

function nextX(doc: CanvasDocument, artboards: string[]): number {
  let maxRight = 0;
  for (const id of artboards) {
    const node = doc.nodes[id];
    if (!node) continue;
    maxRight = Math.max(maxRight, Number(node.attrs['data-x'] ?? 0) + (parseFloat(node.styles.width ?? '1440') || 1440));
  }
  return artboards.length ? maxRight + 120 : 0;
}

// ---------------------------------------------------------------------------
// Agent connections
// ---------------------------------------------------------------------------

api.get('/documents/:id/connections', async (c) =>
  c.json({ connections: await listConnections((await requireDocument(c.req.param('id'))).id) }));

api.post('/documents/:id/connections', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
  const conn = await createConnection(doc.id, body.label);
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

api.delete('/connections/:code', async (c) =>
  (await revokeConnection(c.req.param('code'))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404));

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

api.post('/documents/:id/assets', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'expected a "file" field' }, 400);
  if (file.size > MAX_ASSET_BYTES) return c.json({ error: `file exceeds ${MAX_ASSET_BYTES / 1e6}MB` }, 413);

  const bytes = Buffer.from(await file.arrayBuffer());
  const id = await storeAsset(doc.id, file.type || 'application/octet-stream', file.name, bytes);
  return c.json({ id, url: `${PUBLIC_URL}/assets/${id}`, name: file.name, size: bytes.length }, 201);
});

app.route('/api', api);

app.get('/assets/:id', async (c) => {
  const asset = await getAsset(c.req.param('id'));
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
  const connection = await resolveConnection(c.req.param('code'));
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
if (SERVE_CLIENT && existsSync(WEB_DIST)) {
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

/**
 * Brings a document into the synchronous cache and returns it.
 *
 * Serverless invocations start cold with an empty cache, so every route that
 * touches a document has to go through here rather than reading the cache
 * directly.
 */
async function requireDocument(id: string): Promise<CanvasDocument> {
  await ensureLoaded(id);
  const doc = getDocument(id);
  if (!doc) throw new StoreError(`document ${id} not found`);
  return doc;
}

export { app, PORT, PUBLIC_URL, WEB_DIST };

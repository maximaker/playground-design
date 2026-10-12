/**
 * heymax connect routes: off by default, session or CONNECT_TOKEN auth, and
 * the ConnectItem shape from kit/docs/connect.md.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';

process.env.PLAYGROUND_DB = `/tmp/playground-connect-test-${Date.now()}.db`;
process.env.PLAYGROUND_PUBLIC_URL = 'https://playground.example.test';
process.env.CONNECT_TOKEN = 'test-connect-token';
process.env.LINKS_URL = 'http://127.0.0.1:9'; // nothing listens: the store is "down"
delete process.env.CONNECT_ENABLED;
delete process.env.ID_URL;

const { app } = await import('./app.ts');

let server: ReturnType<typeof serve>;
let base: string;
let cookie = '';
let docId = '';
let projectId = '';

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });

before(async () => {
  const port = 4600 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  server = serve({ fetch: app.fetch, port });
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'a-long-test-password' }),
  });
  cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0]!;
  const json = { cookie, 'content-type': 'application/json' };
  projectId = ((await (await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Brand refresh' }) })).json()) as { id?: string; project?: { id: string } }).project?.id
    ?? '';
  const doc = ((await (await fetch(`${base}/api/documents`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Brand homepage' }) })).json()) as { document: { id: string } }).document;
  docId = doc.id;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('every connect route 404s while CONNECT_ENABLED is off', async () => {
  for (const path of ['/api/connect/status', '/api/connect/search?q=a', '/api/connect/everywhere?q=a', '/api/connect/links?uri=x']) {
    assert.equal((await get(path, { cookie })).status, 404, path);
  }
});

test('with connect on: no credentials is 401, a wrong token is 401', async () => {
  process.env.CONNECT_ENABLED = 'true';
  assert.equal((await get('/api/connect/status')).status, 401);
  assert.equal((await get('/api/connect/status', { authorization: 'Bearer nope' })).status, 401);
});

test('status answers to a session and to the bearer token alone', async () => {
  process.env.CONNECT_ENABLED = 'true';
  const bySession = await get('/api/connect/status', { cookie });
  assert.equal(bySession.status, 200);
  assert.deepEqual(await bySession.json(), { enabled: true, self: 'playground' });
  const byToken = await get('/api/connect/status', { authorization: 'Bearer test-connect-token' });
  assert.equal(byToken.status, 200);
});

test('search returns ConnectItems for docs and projects', async () => {
  process.env.CONNECT_ENABLED = 'true';
  const res = await get('/api/connect/search?q=brand', { authorization: 'Bearer test-connect-token' });
  assert.equal(res.status, 200);
  const { results } = (await res.json()) as { results: Record<string, unknown>[] };
  const doc = results.find((r) => r.type === 'doc');
  assert.ok(doc, 'the document is found');
  assert.equal(doc.app, 'playground');
  assert.equal(doc.uri, `heymax://playground/doc/${docId}`);
  assert.equal(doc.url, `https://playground.example.test/d/${docId}`);
  assert.equal(doc.title, 'Brand homepage');
  assert.equal(typeof doc.updated, 'string');
  if (projectId) {
    const project = results.find((r) => r.type === 'project');
    assert.equal(project?.uri, `heymax://playground/project/${projectId}`);
    assert.equal(project?.url, `https://playground.example.test/?project=${projectId}`);
  }
  const none = (await (await get('/api/connect/search?q=zzzz-nothing', { cookie })).json()) as { results: unknown[] };
  assert.deepEqual(none.results, []);
});

test('item resolves by uri and by url, and 404s on anything else', async () => {
  process.env.CONNECT_ENABLED = 'true';
  const byUri = await get(`/api/connect/item?uri=${encodeURIComponent(`heymax://playground/doc/${docId}`)}`, { cookie });
  assert.equal(byUri.status, 200);
  assert.equal(((await byUri.json()) as { id: string }).id, docId);
  const byUrl = await get(`/api/connect/item?url=${encodeURIComponent(`https://playground.example.test/d/${docId}`)}`, { cookie });
  assert.equal(((await byUrl.json()) as { title: string }).title, 'Brand homepage');
  assert.equal((await get('/api/connect/item?uri=heymax://notes/page/x', { cookie })).status, 404);
  assert.equal((await get('/api/connect/item?uri=heymax://playground/doc/missing', { cookie })).status, 404);
});

test('everywhere puts playground first; unfurl resolves our own URL', async () => {
  process.env.CONNECT_ENABLED = 'true';
  process.env.CONNECT_TIMEOUT_MS = '300';
  const res = await get('/api/connect/everywhere?q=brand&apps=playground,notes', { cookie });
  const { groups } = (await res.json()) as { groups: { app: string; ok: boolean; results: unknown[] }[] };
  assert.equal(groups[0]?.app, 'playground');
  assert.equal(groups[0]?.ok, true);
  assert.ok(groups[0]!.results.length >= 1);
  const unf = await get(`/api/connect/unfurl?ref=${encodeURIComponent(`https://playground.heymax.im/d/${docId}`)}`, { cookie });
  assert.equal(unf.status, 200);
  assert.equal(((await unf.json()) as { uri: string }).uri, `heymax://playground/doc/${docId}`);
});

test('links pass through, and say so when the store is down', async () => {
  process.env.CONNECT_ENABLED = 'true';
  const res = await get('/api/connect/links?uri=heymax://playground/doc/x', { cookie });
  assert.equal(res.status, 503);
});

/**
 * Hardening: rate limits on public writes, security headers, upload checks,
 * scoped/expiring agent links and project-link access.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.PLAYGROUND_DB = `/tmp/playground-security-test-${Date.now()}.db`;
process.env.PLAYGROUND_PUBLIC_URL = 'http://127.0.0.1';
delete process.env.ID_URL;

const { app } = await import('./app.ts');
const { uploadProblem, APP_CSP, ASSET_CSP } = await import('./security.ts');
const { shutdownRenderer } = await import('./render.ts');

let server: ReturnType<typeof serve>;
let base = '';

const json = (cookie: string) => ({ cookie, 'content-type': 'application/json' });

async function signup(email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-long-test-password' }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}

before(async () => {
  const port = 4900 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  server = serve({ fetch: app.fetch, port });
});

after(async () => {
  server.close();
  await shutdownRenderer().catch(() => {});
});

test('public POSTs are rate limited per forwarded IP with a 429', async () => {
  const send = (ip: string) => fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' }),
  });
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await send('203.0.113.7')).status);
  assert.ok(statuses.slice(0, 10).every((s) => s !== 429), String(statuses));
  const limited = await send('203.0.113.7');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  // cf-connecting-ip wins over x-forwarded-for, and another IP has its own count.
  const other = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.7' },
    body: '{}',
  });
  assert.notEqual(other.status, 429);
});

test('share-token writes are rate limited too', async () => {
  let last = 0;
  for (let i = 0; i < 125; i++) {
    last = (await fetch(`${base}/api/shares/not-a-token/ops`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.50' }, body: '{"ops":[]}',
    })).status;
  }
  assert.equal(last, 429);
});

test('security headers are on app, API and asset responses', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(r.headers.get('permissions-policy') ?? '', /camera=\(\)/);
  assert.equal(r.headers.get('content-security-policy'), APP_CSP);
  assert.match(APP_CSP, /frame-ancestors/);
  assert.equal(r.headers.get('strict-transport-security'), null);
  const p = await fetch(`${base}/p/nothing-here`);
  assert.match(p.headers.get('content-security-policy') ?? '', /script-src 'none'/);
});

test('uploads: signatures must match the declared type, per-type size caps apply', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(uploadProblem('image/png', png), null);
  assert.match(uploadProblem('image/png', Buffer.from('<html><script>alert(1)</script>'))!, /not a valid/);
  assert.match(uploadProblem('image/svg+xml', Buffer.alloc(3 * 1024 * 1024))!, /at most 2MB/);
  assert.equal(uploadProblem('text/plain', Buffer.from('hello')), null);
});

test('upload route refuses a disguised file and serves assets sandboxed', async () => {
  const cookie = await signup('uploader@example.com');
  const doc = (await (await fetch(`${base}/api/documents`, { method: 'POST', headers: json(cookie), body: '{"name":"Up"}' })).json()) as { id?: string; document?: { id: string } };
  const docId = doc.document?.id ?? doc.id!;
  const bad = new FormData();
  bad.append('file', new File(['<svg onload=alert(1)>'], 'x.png', { type: 'image/png' }));
  const refused = await fetch(`${base}/api/documents/${docId}/assets`, { method: 'POST', headers: { cookie }, body: bad });
  assert.equal(refused.status, 415);

  const ok = new FormData();
  ok.append('file', new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'x.svg', { type: 'image/svg+xml' }));
  const stored = (await (await fetch(`${base}/api/documents/${docId}/assets`, { method: 'POST', headers: { cookie }, body: ok })).json()) as { id: string };
  const served = await fetch(`${base}/assets/${stored.id}`);
  assert.equal(served.headers.get('content-security-policy'), ASSET_CSP);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
});

test('agent links take scope and expiry; a read link cannot write over MCP', async () => {
  const cookie = await signup('agent-owner@example.com');
  const bad = await fetch(`${base}/api/agents`, { method: 'POST', headers: json(cookie), body: JSON.stringify({ scope: 'admin' }) });
  assert.equal(bad.status, 400);
  const past = await fetch(`${base}/api/agents`, { method: 'POST', headers: json(cookie), body: JSON.stringify({ expiresAt: Date.now() - 1000 }) });
  assert.equal(past.status, 400);

  const made = (await (await fetch(`${base}/api/agents`, {
    method: 'POST', headers: json(cookie), body: JSON.stringify({ scope: 'read', expiresAt: Date.now() + 3_600_000 }),
  })).json()) as { url: string; connection: { readOnly: boolean; expiresAt: number } };
  assert.equal(made.connection.readOnly, true);
  assert.ok(made.connection.expiresAt > Date.now());

  const list = (await (await fetch(`${base}/api/agents`, { headers: { cookie } })).json()) as { links: { scope: string; expiresAt: number | null }[] };
  assert.equal(list.links[0]!.scope, 'read');

  const client = new Client({ name: 'security-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(new URL(made.url).pathname, base)));
  const read = await client.callTool({ name: 'get_basic_info', arguments: {} });
  assert.notEqual(read.isError, true);
  const write = await client.callTool({ name: 'create_artboard', arguments: { name: 'Nope', width: 100, height: 100 } });
  assert.equal(write.isError, true);
  await client.close();

  // Default stays the full-access, non-expiring link.
  const plain = (await (await fetch(`${base}/api/agents`, { method: 'POST', headers: json(cookie), body: '{}' })).json()) as { connection: { readOnly: boolean; expiresAt: number | null } };
  assert.equal(plain.connection.readOnly, false);
  assert.equal(plain.connection.expiresAt, null);
});

test('a project link needs access to every document in the project', async () => {
  const owner = await signup('proj-owner@example.com');
  const stranger = await signup('stranger@example.com');
  const proj = (await (await fetch(`${base}/api/projects`, { method: 'POST', headers: json(owner), body: '{"name":"Private"}' })).json()) as { id?: string; project?: { id: string } };
  const projectId = proj.project?.id ?? proj.id!;
  const doc = (await (await fetch(`${base}/api/documents`, { method: 'POST', headers: json(owner), body: JSON.stringify({ name: 'Secret', projectId }) })).json()) as { id?: string; document?: { id: string } };
  const docId = doc.document?.id ?? doc.id!;
  await fetch(`${base}/api/documents/${docId}/project`, { method: 'PUT', headers: json(owner), body: JSON.stringify({ projectId }) });

  const denied = await fetch(`${base}/api/projects/${projectId}/connections`, { method: 'POST', headers: json(stranger), body: '{}' });
  assert.equal(denied.status, 403);
  const listDenied = await fetch(`${base}/api/projects/${projectId}/connections`, { headers: { cookie: stranger } });
  assert.equal(listDenied.status, 403);
  const allowed = await fetch(`${base}/api/projects/${projectId}/connections`, { method: 'POST', headers: json(owner), body: '{}' });
  assert.equal(allowed.status, 201, await allowed.clone().text());
});

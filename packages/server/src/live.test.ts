/**
 * Live questions: the public answer routes, moderation behind the account
 * gate, and the MCP tools, against a real server.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.PLAYGROUND_DB = `/tmp/playground-live-test-${Date.now()}.db`;
process.env.PLAYGROUND_PUBLIC_URL = 'http://127.0.0.1';
delete process.env.ID_URL;

const { app } = await import('./app.ts');
const { createDocument, getDocument } = await import('./store.ts');
const { createConnection } = await import('./connections.ts');
const { resetLiveLimits } = await import('./live.ts');
const { shutdownRenderer } = await import('./render.ts');

let server: ReturnType<typeof serve>;
let base = '';
let cookie = '';
let docId = '';
let client: Client;
let n = 0;

const jsonHeaders = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', ...extra });

async function createQuestion(question = 'What is your idea in one sentence?'): Promise<string> {
  const r = await fetch(`${base}/api/documents/${docId}/live`, {
    method: 'POST', headers: jsonHeaders({ cookie }), body: JSON.stringify({ question }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  return ((await r.json()) as { code: string }).code;
}

/** A fresh client id per call unless one is given, so tests do not trip each other's limits. */
function answer(code: string, body: Record<string, unknown>) {
  return fetch(`${base}/q/${code}/answers`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ client: `test-client-${++n}`, ...body }),
  });
}

async function state(code: string) {
  const r = await fetch(`${base}/q/${code}/state`);
  return await r.json() as { v: number; open: boolean; total: number; answers: { id: string; name: string; text: string }[] };
}

before(async () => {
  const port = 4500 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  server = serve({ fetch: app.fetch, port });
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ email: 'live@example.com', password: 'a-long-test-password' }),
  });
  cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0]!;
  docId = (await createDocument('Live test')).id;
  const conn = await createConnection(docId, 'Test Agent');
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${conn.code}`)));
});

beforeEach(() => resetLiveLimits());

after(async () => {
  await client.close().catch(() => {});
  await shutdownRenderer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('an answer is cleaned, stored and shown newest first', async () => {
  const code = await createQuestion();
  assert.match(code, /^[a-z2-9]{8}$/);

  const page = await fetch(`${base}/q/${code}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /What is your idea in one sentence\?/);

  assert.equal((await answer(code, { text: 'First idea', name: 'Team 1' })).status, 201);
  const r = await answer(code, { text: '<img src=x onerror=alert(1)>Second <b>idea</b>' + 'x'.repeat(400), name: '<i>Ana</i>' });
  assert.equal(r.status, 201);

  const s = await state(code);
  assert.equal(s.total, 2);
  assert.equal(s.answers[0]!.name, 'Ana');
  assert.ok(s.answers[0]!.text.startsWith('Second idea'));
  assert.equal(s.answers[0]!.text.length, 280);
  assert.ok(!s.answers[0]!.text.includes('<'));
  assert.equal(s.answers[1]!.text, 'First idea');
  // The board never learns which document it belongs to.
  assert.ok(!JSON.stringify(s).includes(docId));

  assert.equal((await answer(code, { text: '   ' })).status, 400);
  assert.equal((await fetch(`${base}/q/zzzzzzzz`)).status, 404);
});

test('one client is held to one answer every few seconds', async () => {
  const code = await createQuestion();
  const send = () => fetch(`${base}/q/${code}/answers`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ client: 'same-phone-123', text: 'again' }),
  });
  assert.equal((await send()).status, 201);
  const second = await send();
  assert.equal(second.status, 429);
  assert.match(((await second.json()) as { error: string }).error, /moment/);
  // Someone else on the same network is not held back.
  assert.equal((await answer(code, { text: 'mine' })).status, 201);
});

test('a closed question takes no answers and says so', async () => {
  const code = await createQuestion();
  const close = await fetch(`${base}/api/live/${code}`, {
    method: 'PATCH', headers: jsonHeaders({ cookie }), body: JSON.stringify({ open: false }),
  });
  assert.equal(close.status, 200);
  const r = await answer(code, { text: 'too late' });
  assert.equal(r.status, 409);
  assert.equal((await state(code)).open, false);
  assert.match(await (await fetch(`${base}/q/${code}`)).text(), /This question is closed/);
});

test('hiding needs an account; hidden answers stay stored but leave the board', async () => {
  const code = await createQuestion();
  await answer(code, { text: 'keep' });
  await answer(code, { text: 'remove me' });
  const target = (await state(code)).answers.find((a) => a.text === 'remove me')!;

  const anonymous = await fetch(`${base}/api/live/${code}/answers/${target.id}/hide`, { method: 'POST' });
  assert.equal(anonymous.status, 401);

  const hidden = await fetch(`${base}/api/live/${code}/answers/${target.id}/hide`, {
    method: 'POST', headers: jsonHeaders({ cookie }), body: '{}',
  });
  assert.equal(hidden.status, 200);
  const s = await state(code);
  assert.deepEqual(s.answers.map((a) => a.text), ['keep']);

  const full = await (await fetch(`${base}/api/live/${code}`, { headers: { cookie } })).json() as { canModerate: boolean; answers: { hidden: boolean }[] };
  assert.equal(full.canModerate, true);
  assert.equal(full.answers.length, 2);

  const cleared = await fetch(`${base}/api/live/${code}/clear`, { method: 'POST', headers: { cookie } });
  assert.deepEqual(await cleared.json(), { hidden: 1 });
  assert.equal((await state(code)).total, 0);
});

test('the board state is held until something changes', async () => {
  const code = await createQuestion();
  const { v } = await state(code);
  const started = Date.now();
  const waiting = fetch(`${base}/q/${code}/state?v=${v}&wait=5000`).then((r) => r.json() as Promise<{ v: number; total: number }>);
  await new Promise((ok) => setTimeout(ok, 150));
  await answer(code, { text: 'live!' });
  const next = await waiting;
  assert.ok(next.v > v);
  assert.equal(next.total, 1);
  assert.ok(Date.now() - started < 3000, 'answered on change, not on timeout');

  const board = await fetch(`${base}/q/${code}/board?font=Inter&ink=%23fff&accent=red;}body{x:1`);
  const html = await board.text();
  assert.equal(board.status, 200);
  assert.match(html, /<svg[^>]+viewBox/);
  assert.match(html, /family=Inter/);
  assert.ok(!html.includes('body{x:1'), 'look settings cannot inject CSS');
});

test('MCP: add_live_question, list_live_answers, hide_live_answer, set_live_question', async () => {
  const doc = getDocument(docId)!;
  const artboardId = doc.pages[0]!.artboards[0]!;
  const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;

  const added = JSON.parse(text(await client.callTool({
    name: 'add_live_question', arguments: { question: 'Vitamin or painkiller?', artboardId },
  }))) as { id: string; code: string; answerUrl: string };
  assert.equal(added.answerUrl, `http://127.0.0.1/q/${added.code}`);
  const embed = getDocument(docId)!.nodes[added.id]!;
  assert.equal(embed.type, 'embed');
  assert.equal(embed.parent, artboardId);
  assert.equal(embed.attrs['data-live-question'], added.code);

  await answer(added.code, { text: 'Painkiller', name: 'Team A' });
  await answer(added.code, { text: 'Vitamin' });

  const listed = JSON.parse(text(await client.callTool({ name: 'list_live_answers', arguments: { code: added.code } }))) as
    { answers: { id: string; text: string; hidden: boolean }[] }[];
  assert.deepEqual(listed[0]!.answers.map((a) => a.text), ['Painkiller', 'Vitamin']);

  const hid = JSON.parse(text(await client.callTool({
    name: 'hide_live_answer', arguments: { code: added.code, answerId: listed[0]!.answers[1]!.id },
  }))) as { hidden: boolean };
  assert.equal(hid.hidden, true);
  assert.deepEqual((await state(added.code)).answers.map((a) => a.text), ['Painkiller']);

  await client.callTool({ name: 'set_live_question', arguments: { code: added.code, open: false } });
  assert.equal((await answer(added.code, { text: 'late' })).status, 409);

  const missing = await client.callTool({ name: 'hide_live_answer', arguments: { code: 'zzzzzzzz', answerId: 'x' } });
  assert.equal((missing as { isError?: boolean }).isError, true);
});

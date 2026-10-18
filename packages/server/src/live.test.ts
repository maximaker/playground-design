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

const jsonHeaders = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', ...extra });

async function createQuestion(question = 'What is your idea in one sentence?', settings: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(`${base}/api/documents/${docId}/live`, {
    method: 'POST', headers: jsonHeaders({ cookie }), body: JSON.stringify({ question, ...settings }),
  });
  assert.equal(r.status, 201, await r.clone().text());
  return ((await r.json()) as { code: string }).code;
}

/** With no device, every call is a new phone, so tests do not trip each other's limits. */
function answer(code: string, body: Record<string, unknown>, device?: string) {
  return fetch(`${base}/q/${code}/answers`, {
    method: 'POST', headers: jsonHeaders(device ? { 'x-live-device': device } : {}), body: JSON.stringify(body),
  });
}

function vote(code: string, option: number, device?: string) {
  return fetch(`${base}/q/${code}/vote`, {
    method: 'POST', headers: jsonHeaders(device ? { 'x-live-device': device } : {}), body: JSON.stringify({ option }),
  });
}

/** A phone: the signed token the server hands out, as the page would keep it. */
async function phone(code: string): Promise<string> {
  const r = await fetch(`${base}/q/${code}/me`);
  assert.match(r.headers.get('set-cookie') ?? '', /pg_live=.*HttpOnly/);
  return ((await r.json()) as { device: string }).device;
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

test('one phone is held to one answer every few seconds', async () => {
  const code = await createQuestion('Many ideas?', { onePerPerson: false });
  const device = await phone(code);
  const send = () => answer(code, { text: 'again' }, device);
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
  // The screenshot renderer frames it from about:blank; a framing rule left it blank.
  assert.ok(!/frame-ancestors/.test(board.headers.get('content-security-policy') ?? ''));
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

test('once per person: a second answer from the same phone is refused, by cookie or by kept token', async () => {
  const code = await createQuestion();
  const first = await answer(code, { text: 'mine' });
  assert.equal(first.status, 201);
  const jar = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
  const token = ((await first.json()) as { device: string }).device;

  const byCookie = await fetch(`${base}/q/${code}/answers`, { method: 'POST', headers: jsonHeaders({ cookie: jar }), body: JSON.stringify({ text: 'again' }) });
  assert.equal(byCookie.status, 409);
  assert.match(((await byCookie.json()) as { error: string }).error, /already answered/);
  assert.equal((await answer(code, { text: 'again' }, token)).status, 409);

  const me = await (await fetch(`${base}/q/${code}/me`, { headers: { 'x-live-device': token } })).json() as { answered: boolean };
  assert.equal(me.answered, true);

  // A made-up token is not that phone: it is ignored and a new one minted.
  const [id] = token.split('.');
  const forged = await fetch(`${base}/q/${code}/me`, { headers: { 'x-live-device': `${id}.AAAAAAAAAAAAAAAAAAAAAA` } });
  const forgedView = await forged.json() as { answered: boolean; device: string };
  assert.equal(forgedView.answered, false);
  assert.notEqual(forgedView.device.split('.')[0], id);

  // Questions made before the setting existed keep taking several.
  const { updateLiveQuestion } = await import('./live.ts');
  await updateLiveQuestion(code, { onePerPerson: false });
  resetLiveLimits();
  assert.equal((await answer(code, { text: 'second idea' }, token)).status, 201);
});

test('poll: one vote per phone that can be changed, percentages, close, reset, options', async () => {
  const code = await createQuestion('Vitamin or painkiller?', { kind: 'poll', options: ['Vitamin', 'Painkiller'] });
  const a = await phone(code);
  const b = await phone(code);
  assert.equal((await vote(code, 0, a)).status, 201);
  assert.equal((await vote(code, 1, b)).status, 201);
  resetLiveLimits(); // the per-phone gap is not what this test is about
  const changed = await vote(code, 1, a);
  assert.equal(changed.status, 201);
  assert.equal(((await changed.json()) as { changed: boolean }).changed, true);
  assert.equal((await vote(code, 5, a)).status, 400);
  assert.equal((await answer(code, { text: 'words' })).status, 400);

  const s = await (await fetch(`${base}/q/${code}/state`)).json() as { kind: string; total: number; options: { label: string; count: number; percent: number }[] };
  assert.equal(s.kind, 'poll');
  assert.equal(s.total, 2);
  assert.deepEqual(s.options, [{ label: 'Vitamin', count: 0, percent: 0 }, { label: 'Painkiller', count: 2, percent: 100 }]);
  const me = await (await fetch(`${base}/q/${code}/me`, { headers: { 'x-live-device': a } })).json() as { answered: boolean; vote: number };
  assert.deepEqual([me.answered, me.vote], [true, 1]);

  const patch = (body: unknown) => fetch(`${base}/api/live/${code}`, { method: 'PATCH', headers: jsonHeaders({ cookie }), body: JSON.stringify(body) });
  assert.equal((await patch({ options: ['A', 'B', 'C'] })).status, 409, 'no relabelling under votes');

  await patch({ open: false });
  assert.equal((await vote(code, 0)).status, 409);
  const reset = await fetch(`${base}/api/live/${code}/clear`, { method: 'POST', headers: { cookie } });
  assert.deepEqual(await reset.json(), { votesReset: 2 });
  assert.equal((await patch({ options: ['A', 'B', 'C'], open: true })).status, 200);
  assert.equal((await vote(code, 2)).status, 201);

  const page = await (await fetch(`${base}/q/${code}`)).text();
  assert.match(page, /class="choice" data-i="2">C</);
  assert.equal((await fetch(`${base}/api/documents/${docId}/live`, {
    method: 'POST', headers: jsonHeaders({ cookie }), body: JSON.stringify({ question: 'x', kind: 'poll', options: ['only one'] }),
  })).status, 400);
});

test('votable answers: one like per phone per answer, not your own, ranked by likes', async () => {
  const code = await createQuestion('Best problem statement?', { votable: true });
  const author = await phone(code);
  await answer(code, { text: 'older' });
  await answer(code, { text: 'liked one' }, author);
  await answer(code, { text: 'newest' });
  const liked = (await state(code)).answers.find((a) => a.text === 'liked one')!;
  const like = (device: string, on = true) => fetch(`${base}/q/${code}/answers/${liked.id}/like`, {
    method: 'POST', headers: jsonHeaders({ 'x-live-device': device }), body: JSON.stringify({ liked: on }),
  });

  assert.equal((await like(author)).status, 409, 'not your own');
  const fan = await phone(code);
  assert.deepEqual(((await (await like(fan)).json()) as { likes: number }).likes, 1);
  assert.deepEqual(((await (await like(fan)).json()) as { likes: number }).likes, 1, 'twice is still one');

  const s = await (await fetch(`${base}/q/${code}/state`)).json() as { votable: boolean; answers: { text: string; likes: number }[] };
  assert.equal(s.votable, true);
  assert.deepEqual(s.answers.map((a) => [a.text, a.likes]), [['liked one', 1], ['newest', 0], ['older', 0]]);
  const me = await (await fetch(`${base}/q/${code}/me`, { headers: { 'x-live-device': fan } })).json() as { answers: { liked: boolean }[] };
  assert.equal(me.answers[0]!.liked, true);
  assert.equal(((await (await like(fan, false)).json()) as { likes: number }).likes, 0);
  assert.ok(!JSON.stringify(s).includes(fan.split('.')[0]!), 'devices never reach the board');
});

test('MCP: a poll through add_live_question, counted by list_live_answers', async () => {
  const doc = getDocument(docId)!;
  const artboardId = doc.pages[0]!.artboards[0]!;
  const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;
  const added = JSON.parse(text(await client.callTool({
    name: 'add_live_question', arguments: { question: 'Ship it?', artboardId, kind: 'poll', options: ['Yes', 'No', 'Later'] },
  }))) as { code: string; kind: string };
  assert.equal(added.kind, 'poll');
  await vote(added.code, 0);
  await vote(added.code, 0);
  await vote(added.code, 2);
  const listed = JSON.parse(text(await client.callTool({ name: 'list_live_answers', arguments: { code: added.code } }))) as
    { kind: string; totalVotes: number; options: { label: string; votes: number; percent: number }[] }[];
  assert.equal(listed[0]!.totalVotes, 3);
  assert.deepEqual(listed[0]!.options.map((o) => [o.label, o.votes, o.percent]), [['Yes', 2, 67], ['No', 0, 0], ['Later', 1, 33]]);

  const refused = await client.callTool({ name: 'set_live_question', arguments: { code: added.code, options: ['Y', 'N'] } });
  assert.equal((refused as { isError?: boolean }).isError, true);
  const relabelled = JSON.parse(text(await client.callTool({
    name: 'set_live_question', arguments: { code: added.code, clear: true, options: ['Y', 'N'] },
  }))) as { options: { label: string }[]; cleared: { votesReset: number } };
  assert.deepEqual(relabelled.options.map((o) => o.label), ['Y', 'N']);
  assert.equal(relabelled.cleared.votesReset, 3);
});

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
  assert.deepEqual(await cleared.json(), { round: 2, archived: 2 });
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
  assert.deepEqual(await reset.json(), { round: 2, archived: 2 });
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
  }))) as { options: { label: string }[]; cleared: { archived: number } };
  assert.deepEqual(relabelled.options.map((o) => o.label), ['Y', 'N']);
  assert.equal(relabelled.cleared.archived, 3);
});

test('presenter controls: slide order, editors only, CSV, the board link, and the list tool', async () => {
  const doc = getDocument(docId)!;
  const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;
  const artboardId = doc.pages[0]!.artboards[0]!;
  const placed = JSON.parse(text(await client.callTool({
    name: 'add_live_question', arguments: { question: 'On the slide', artboardId },
  }))) as { code: string };
  await answer(placed.code, { text: '=SUM(A1), "quoted"', name: 'Team, one' });

  const page = await fetch(`${base}/d/${docId}/live`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Presenter controls/);

  const list = await fetch(`${base}/api/documents/${docId}/live`, { headers: { cookie } });
  const { questions } = await list.json() as { questions: { code: string; placement: { slide: number } | null; answers: number }[] };
  const first = questions.findIndex((q) => q.placement);
  // Placed questions come first, in slide order; ones on no slide after them.
  assert.ok(questions.slice(first).every((q, i, all) => !q.placement || all.slice(0, i).every((p) => p.placement)));
  const mine = questions.find((q) => q.code === placed.code)!;
  assert.equal(mine.placement!.slide, 1);
  assert.equal(mine.answers, 1);
  assert.ok(!JSON.stringify(questions).includes('"device"'));

  assert.equal((await fetch(`${base}/api/documents/${docId}/live`)).status, 401);
  const stranger = (await (await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: 'stranger@example.com', password: 'a-long-test-password' }),
  })).headers.get('set-cookie') ?? '').split(';')[0]!;
  // A document with an owner is closed to everyone else (the test document has none, so anyone may).
  const owned = ((await (await fetch(`${base}/api/documents`, {
    method: 'POST', headers: jsonHeaders({ cookie }), body: JSON.stringify({ name: 'Owned' }),
  })).json()) as { document: { id: string } }).document.id;
  assert.equal((await fetch(`${base}/api/documents/${owned}/live`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/documents/${owned}/live`, { headers: { cookie: stranger } })).status, 404);

  const csv = await fetch(`${base}/api/live/${placed.code}/csv`, { headers: { cookie } });
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  const body = await csv.text();
  assert.match(body, /^time,name,answer,hidden\r\n/);
  assert.match(body, /"Team, one","'=SUM\(A1\), ""quoted""",no/);

  const go = await fetch(`${base}/api/live/${placed.code}/controls`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), `/d/${docId}/live#${placed.code}`);
  assert.equal((await fetch(`${base}/api/live/${placed.code}/controls`, { redirect: 'manual' })).status, 401);

  const listed = JSON.parse(text(await client.callTool({ name: 'list_live_questions', arguments: {} }))) as { controls: string; questions: { code: string }[] };
  assert.ok(listed.controls.endsWith(`/d/${docId}/live`));
  assert.ok(listed.questions.some((q) => q.code === placed.code));
});

test('qr: false hides the QR block, from the question or the board URL', async () => {
  const code = await createQuestion('No QR here', { qr: false });
  assert.equal(((await (await fetch(`${base}/q/${code}/state`)).json()) as { qr: boolean }).qr, false);
  const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;
  await client.callTool({ name: 'set_live_question', arguments: { code, qr: true } });
  assert.equal(((await (await fetch(`${base}/q/${code}/state`)).json()) as { qr: boolean }).qr, true);
  const off = JSON.parse(text(await client.callTool({ name: 'set_live_question', arguments: { code, qr: false } }))) as { qr: boolean };
  assert.equal(off.qr, false);
  const board = await (await fetch(`${base}/q/${(await createQuestion())}/board?qr=0`)).text();
  assert.match(board, /const qrOff = true;/);
});

const FORM_FIELDS = [
  { id: 'useful', type: 'rating', label: 'How useful was this session?', lowLabel: 'Not useful', highLabel: 'Very useful', required: true },
  { id: 'recommend', type: 'choice', label: 'Would you recommend it?', options: ['Yes', 'Maybe', 'No'] },
  { id: 'change', type: 'text', label: 'One thing to change?' },
  { id: 'email', type: 'text', label: 'Follow-up contact', onBoard: false },
];

function submit(code: string, values: Record<string, unknown>, device?: string) {
  return fetch(`${base}/q/${code}/submit`, {
    method: 'POST', headers: jsonHeaders(device ? { 'x-live-device': device } : {}), body: JSON.stringify({ values }),
  });
}

type FormState = { kind: string; total: number; fields: { id: string; average?: number | null; distribution?: number[]; options?: { count: number }[]; answers?: { id: string; text: string }[]; shown?: number }[] };

test('form: validated on create, required enforced, one submission per phone that is replaced, aggregates on the board', async () => {
  const bad = await fetch(`${base}/api/documents/${docId}/live`, {
    method: 'POST', headers: jsonHeaders({ cookie }), body: JSON.stringify({ question: 'Feedback', kind: 'form', fields: [] }),
  });
  assert.equal(bad.status, 400);
  const code = await createQuestion('Session feedback', { kind: 'form', fields: FORM_FIELDS });

  const page = await (await fetch(`${base}/q/${code}`)).text();
  assert.match(page, /class="pip" data-v="5"/);
  assert.match(page, /Not useful/);
  assert.match(page, /data-required="1"/);

  assert.equal((await submit(code, { recommend: 0 })).status, 400, 'required rating missing');
  assert.equal((await answer(code, { text: 'hi' })).status, 400, 'a form takes /submit, not /answers');
  const me = await phone(code);
  const first = await submit(code, { useful: 2, recommend: 'No', change: '<b>Shorter</b> intro', email: 'x@example.com' }, me);
  assert.equal(first.status, 201);
  const firstBody = await first.json() as { id: string; replaced: boolean };
  assert.equal(firstBody.replaced, false);
  await submit(code, { useful: 5, recommend: 0 });
  await submit(code, { useful: 4, recommend: 1, change: 'More examples' });

  await new Promise((ok) => setTimeout(ok, 1100));
  const again = await submit(code, { useful: 4, recommend: 'Yes', change: 'Shorter intro please' }, me);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json().then((b: { id: string; replaced: boolean }) => [b.id, b.replaced]), [firstBody.id, true]);

  const view = await (await fetch(`${base}/q/${code}/me`, { headers: { 'x-live-device': me } })).json() as { answered: boolean; values: Record<string, unknown> };
  assert.equal(view.answered, true);
  assert.deepEqual(view.values, { useful: 4, recommend: 0, change: 'Shorter intro please' });

  const s = await (await fetch(`${base}/q/${code}/state`)).json() as FormState;
  assert.equal(s.kind, 'form');
  assert.equal(s.total, 3);
  assert.deepEqual(s.fields.map((f) => f.id), ['useful', 'recommend', 'change'], 'onBoard: false stays off the board');
  assert.equal(s.fields[0]!.average, 4.3);
  assert.deepEqual(s.fields[0]!.distribution, [0, 0, 0, 2, 1]);
  assert.deepEqual(s.fields[1]!.options!.map((o) => o.count), [2, 1, 0]);
  assert.deepEqual(s.fields[2]!.answers!.map((a) => a.text), ['Shorter intro please', 'More examples']);
  assert.ok(!JSON.stringify(s).includes('device'));

  await fetch(`${base}/api/live/${code}`, { method: 'PATCH', headers: jsonHeaders({ cookie }), body: JSON.stringify({ open: false }) });
  assert.equal((await submit(code, { useful: 3 })).status, 409);
});

test('form: moderation hides single written answers, clear starts a new round, reset deletes, CSV has a column per field', async () => {
  const code = await createQuestion('Feedback two', { kind: 'form', fields: FORM_FIELDS });
  await submit(code, { useful: 3, recommend: 2, change: '=cmd()', email: 'a@example.com' });
  await submit(code, { useful: 5, change: 'Nothing' });

  const detail = await (await fetch(`${base}/api/live/${code}`, { headers: { cookie } })).json() as {
    fields: { id: string; answers?: { id: string; text: string }[] }[]; submissions: { id: string; values: Record<string, unknown> }[]; totalResponses: number;
  };
  assert.equal(detail.totalResponses, 2);
  assert.equal(detail.submissions[0]!.values.recommend, 'No');
  const target = detail.fields.find((f) => f.id === 'change')!.answers!.find((a) => a.text === 'Nothing')!;
  assert.equal((await fetch(`${base}/api/live/${code}/answers/${encodeURIComponent(target.id)}/hide`, { method: 'POST' })).status, 401);
  const hid = await fetch(`${base}/api/live/${code}/answers/${encodeURIComponent(target.id)}/hide`, {
    method: 'POST', headers: jsonHeaders({ cookie }), body: JSON.stringify({ hidden: true }),
  });
  assert.equal(hid.status, 200);
  let s = await (await fetch(`${base}/q/${code}/state`)).json() as FormState;
  assert.deepEqual(s.fields[2]!.answers!.map((a) => a.text), ['=cmd()']);
  assert.equal(s.fields[0]!.average, 4, 'ratings are not touched by hiding text');

  const csv = await (await fetch(`${base}/api/live/${code}/csv`, { headers: { cookie } })).text();
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'time,edited,How useful was this session?,Would you recommend it?,One thing to change?,Follow-up contact,hidden');
  assert.match(lines[1]!, /,3,No,'=cmd\(\),a@example.com,$/);
  assert.match(lines[2]!, /,5,,Nothing,,One thing to change\?$/);

  const list = await (await fetch(`${base}/api/documents/${docId}/live`, { headers: { cookie } })).json() as { questions: { code: string; answers: number; totalResponses: number }[] };
  const listed = list.questions.find((q) => q.code === code)!;
  assert.equal(listed.answers, 2);
  assert.ok(!JSON.stringify(listed).includes('Nothing'), 'the list carries counts, not what people wrote');

  const cleared = await (await fetch(`${base}/api/live/${code}/clear`, { method: 'POST', headers: { cookie } })).json() as { archived: number };
  assert.equal(cleared.archived, 2);
  s = await (await fetch(`${base}/q/${code}/state`)).json() as FormState;
  assert.equal(s.fields[2]!.shown, 0);
  assert.equal(s.total, 0);
  assert.equal(s.fields[0]!.average, null, 'a new round starts the ratings over too');

  await submit(code, { useful: 2 });
  const reset = await (await fetch(`${base}/api/live/${code}/reset`, { method: 'POST', headers: { cookie } })).json() as { submissionsReset: number };
  assert.equal(reset.submissionsReset, 1);
  assert.equal(((await (await fetch(`${base}/q/${code}/state`)).json()) as FormState).total, 0);
});

test('MCP: a form through add_live_question, list_live_answers and set_live_question', async () => {
  const doc = getDocument(docId)!;
  const artboardId = doc.pages[0]!.artboards[0]!;
  const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;

  const noFields = await client.callTool({ name: 'add_live_question', arguments: { question: 'Feedback', artboardId, kind: 'form' } });
  assert.equal((noFields as { isError?: boolean }).isError, true);
  const added = JSON.parse(text(await client.callTool({
    name: 'add_live_question', arguments: { question: 'Session feedback', artboardId, kind: 'form', fields: FORM_FIELDS, qr: false },
  }))) as { code: string; kind: string };
  assert.equal(added.kind, 'form');

  const before = JSON.parse(text(await client.callTool({
    name: 'set_live_question', arguments: { code: added.code, fields: FORM_FIELDS.slice(0, 2) },
  }))) as { fields: unknown[] };
  assert.equal(before.fields.length, 2, 'fields change freely before any response');
  await client.callTool({ name: 'set_live_question', arguments: { code: added.code, fields: FORM_FIELDS } });

  await submit(added.code, { useful: 4, recommend: 0, change: 'Less slides' });
  await submit(added.code, { useful: 2, recommend: 2 });

  const listed = JSON.parse(text(await client.callTool({ name: 'list_live_answers', arguments: { code: added.code } }))) as {
    total: number; fields: { id: string; average?: number; distribution?: number[]; options?: { label: string; count: number }[]; answers?: { id: string; text: string }[] }[];
    submissions: { values: Record<string, unknown> }[];
  }[];
  const form = listed[0]!;
  assert.equal(form.total, 2);
  assert.equal(form.fields[0]!.average, 3);
  assert.deepEqual(form.fields[0]!.distribution, [0, 1, 0, 1, 0]);
  assert.deepEqual(form.fields[1]!.options!.map((o) => o.count), [1, 0, 1]);
  assert.deepEqual(form.submissions.map((s) => s.values.recommend), ['Yes', 'No']);
  const answerId = form.fields[2]!.answers![0]!.id;

  const hid = JSON.parse(text(await client.callTool({ name: 'hide_live_answer', arguments: { code: added.code, answerId } }))) as { hidden: boolean };
  assert.equal(hid.hidden, true);

  const refused = await client.callTool({ name: 'set_live_question', arguments: { code: added.code, fields: FORM_FIELDS.slice(0, 2) } });
  assert.equal((refused as { isError?: boolean }).isError, true, 'fields are locked once there are responses');
  const offBoard = FORM_FIELDS.map((f) => (f.id === 'change' ? { ...f, onBoard: false } : f));
  await client.callTool({ name: 'set_live_question', arguments: { code: added.code, fields: offBoard } });
  const s = await (await fetch(`${base}/q/${added.code}/state`)).json() as FormState;
  assert.deepEqual(s.fields.map((f) => f.id), ['useful', 'recommend'], 'onBoard may change under responses');

  const reset = JSON.parse(text(await client.callTool({
    name: 'set_live_question', arguments: { code: added.code, resetResponses: true, fields: FORM_FIELDS.slice(0, 1) },
  }))) as { answerCount: number; fields: unknown[] };
  assert.equal(reset.answerCount, 0);
  assert.equal(reset.fields.length, 1);
});

test('deleteLiveQuestion removes the question and its answers', async () => {
  const { createLiveQuestion, deleteLiveQuestion, getLiveQuestion } = await import('./live.ts');
  const q = await createLiveQuestion(docId, 'Gone soon?');
  assert.deepEqual(await deleteLiveQuestion(q.code), { deleted: q.code });
  assert.equal(await getLiveQuestion(q.code), null);
});

test('discoverable controls: the list names the document, each question has a QR, the library counts them', async () => {
  const code = await createQuestion('Found from the library?');
  const list = await (await fetch(`${base}/api/documents/${docId}/live`, { headers: { cookie } })).json() as { name: string; questions: { code: string }[] };
  assert.equal(list.name, getDocument(docId)!.name);
  assert.ok(list.questions.some((q) => q.code === code));

  const qr = await fetch(`${base}/q/${code}/qr`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.match(await qr.text(), /^<svg /);
  assert.equal((await fetch(`${base}/q/zzzzzzzz/qr`)).status, 404);

  const page = await (await fetch(`${base}/d/${docId}/live`)).text();
  assert.match(page, /Back to the document/);
  assert.match(page, /Clear all answers/);

  const { documents } = await (await fetch(`${base}/api/documents`, { headers: { cookie } })).json() as { documents: { id: string; liveQuestions: number }[] };
  assert.ok((documents.find((d) => d.id === docId)?.liveQuestions ?? 0) >= 1);
});

test('clearing starts a new round: zero everywhere, the same phone answers again, the archive downloads, delete removes it', async () => {
  const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;
  const code = await createQuestion('Same phones on Friday?');
  const me = await phone(code);
  assert.equal((await answer(code, { text: 'Tuesday answer' }, me)).status, 201);
  assert.equal((await answer(code, { text: 'twice' }, me)).status, 409, 'once per person within a round');
  await answer(code, { text: 'another phone' });

  const cleared = await (await fetch(`${base}/api/live/${code}/clear`, { method: 'POST', headers: { cookie } })).json();
  assert.deepEqual(cleared, { round: 2, archived: 2 });

  // Counted nowhere: the slide, the moderator view, the control list, the CSV, the phone, MCP.
  assert.equal((await state(code)).total, 0);
  const view = await (await fetch(`${base}/api/live/${code}`, { headers: { cookie } })).json() as
    { round: number; answers: unknown[]; pastRounds: { round: number; count: number }[] };
  assert.equal(view.round, 2);
  assert.equal(view.answers.length, 0);
  assert.deepEqual(view.pastRounds.map((r) => [r.round, r.count]), [[1, 2]]);
  const list = await (await fetch(`${base}/api/documents/${docId}/live`, { headers: { cookie } })).json() as { questions: { code: string; answers: number; shown: number }[] };
  const listed = list.questions.find((q) => q.code === code)!;
  assert.deepEqual([listed.answers, listed.shown], [0, 0]);
  assert.ok(!JSON.stringify(list).includes('Tuesday answer'));
  const csv = await (await fetch(`${base}/api/live/${code}/csv`, { headers: { cookie } })).text();
  assert.equal(csv.trim().split('\r\n').length, 1, 'current-round CSV is just the header');
  const mine = await (await fetch(`${base}/q/${code}/me`, { headers: { 'x-live-device': me } })).json() as { answered: boolean };
  assert.equal(mine.answered, false);
  const mcpNow = JSON.parse(text(await client.callTool({ name: 'list_live_answers', arguments: { code } }))) as { total: number; answers: unknown[] }[];
  assert.deepEqual([mcpNow[0]!.total, mcpNow[0]!.answers.length], [0, 0]);

  // The same phone answers again.
  assert.equal((await answer(code, { text: 'Friday answer' }, me)).status, 201);
  assert.deepEqual((await state(code)).answers.map((a) => a.text), ['Friday answer']);

  // The archive: every round in the CSV and through MCP.
  const all = await (await fetch(`${base}/api/live/${code}/csv?rounds=all`, { headers: { cookie } })).text();
  const rows = all.trim().split('\r\n');
  assert.match(rows[0]!, /^round,time,name,answer/);
  assert.equal(rows.length, 4);
  assert.ok(rows.some((r) => r.startsWith('1,') && r.includes('Tuesday answer')));
  assert.ok(rows.some((r) => r.startsWith('2,') && r.includes('Friday answer')));
  const mcpAll = JSON.parse(text(await client.callTool({ name: 'list_live_answers', arguments: { code, round: 'all' } }))) as
    { answers: { text: string }[]; pastRounds: { round: number; answers: { text: string }[] }[] }[];
  assert.deepEqual(mcpAll[0]!.answers.map((a) => a.text), ['Friday answer']);
  assert.equal(mcpAll[0]!.pastRounds[0]!.round, 1);
  assert.equal(mcpAll[0]!.pastRounds[0]!.answers.length, 2);
  const mcpOne = JSON.parse(text(await client.callTool({ name: 'list_live_answers', arguments: { code, round: 1 } }))) as { answers: unknown[] }[];
  assert.equal(mcpOne[0]!.answers.length, 2);

  // Delete permanently: editors only, and the archive is gone, the current round stays.
  assert.equal((await fetch(`${base}/api/live/${code}/rounds/delete`, { method: 'POST' })).status, 401);
  const deleted = await (await fetch(`${base}/api/live/${code}/rounds/delete`, { method: 'POST', headers: { cookie } })).json();
  assert.deepEqual(deleted, { deletedRounds: 1, deletedAnswers: 2 });
  const after = await (await fetch(`${base}/api/live/${code}/csv?rounds=all`, { headers: { cookie } })).text();
  assert.ok(!after.includes('Tuesday answer') && !after.includes('another phone'));
  const { getLiveQuestion } = await import('./live.ts');
  const stored = await getLiveQuestion(code);
  assert.equal(stored!.pastRounds, undefined);
  assert.equal(stored!.answers.length, 1);
});

test('a poll cleared into a new round: votes zero, the same phone votes again, old labels kept in the archive', async () => {
  const code = await createQuestion('Pick one', { kind: 'poll', options: ['Red', 'Blue'] });
  const me = await phone(code);
  assert.equal((await vote(code, 0, me)).status, 201);
  await fetch(`${base}/api/live/${code}/clear`, { method: 'POST', headers: { cookie } });
  assert.equal((await state(code)).total, 0);
  assert.equal((await fetch(`${base}/api/live/${code}`, { method: 'PATCH', headers: jsonHeaders({ cookie }), body: JSON.stringify({ options: ['Green', 'Gold'] }) })).status, 200);
  assert.equal((await vote(code, 1, me)).status, 201);
  const me2 = await (await fetch(`${base}/q/${code}/me`, { headers: { 'x-live-device': me } })).json() as { vote: number };
  assert.equal(me2.vote, 1);
  const rows = (await (await fetch(`${base}/api/live/${code}/csv?rounds=all`, { headers: { cookie } })).text()).trim().split('\r\n');
  assert.deepEqual(rows, ['round,option,votes,percent', '1,Red,1,100', '1,Blue,0,0', '2,Green,0,0', '2,Gold,1,100']);
});

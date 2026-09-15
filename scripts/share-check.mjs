/**
 * End-to-end checks for share links.
 *
 * The thing being tested is a negative — that a viewer *cannot* do something —
 * and negatives are where UI-only enforcement quietly fails. So the write is
 * attempted over the real socket, not through the interface that hides the
 * button, and the document is re-read afterwards to confirm nothing moved.
 *
 * The other half is that the link must not leak the document id: the id is the
 * edit credential, so a viewer who learns it can just open the editor instead
 * and the whole feature is decoration.
 */

import './lib/session.mjs';  // signs these checks in; see the module header
import { chromium } from 'playwright';
import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const post = async (path, body) => (await fetch(`${BASE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
})).json();

const doc = await post('/api/documents', { name: 'Share check', template: 'clean' });
const docId = doc.document.id;
const artboard = Object.values(doc.document.nodes).find((n) => n.type === 'artboard');

const made = await post(`/api/documents/${docId}/shares`, { label: 'Check' });
const token = made.share.token;
check('a share link can be created', !!token && made.url.endsWith(token));

// --- The link resolves, without handing over the document id ---------------

const resolved = await (await fetch(`${BASE}/api/shares/${token}`)).json();
check('the link opens the document', resolved.name === 'Share check' && !!resolved.document);
check('it never reveals the document id',
  resolved.document.id !== docId && !JSON.stringify(resolved).includes(docId),
  resolved.document.id);

// --- A viewer's writes are refused by the server, not just hidden ----------

/**
 * Serverless hosts cannot hold a WebSocket open at all, so the socket half of
 * this runs only where there is one. The HTTP half below runs everywhere, and
 * is the path the deployed product actually uses — skipping it there would mean
 * testing the transport that production never takes.
 */
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
const seen = [];
ws.on('message', (m) => seen.push(JSON.parse(String(m))));
const socketWorks = await new Promise((resolve) => {
  ws.on('open', () => resolve(true));
  ws.on('error', () => resolve(false));
});

if (socketWorks) {
  ws.send(JSON.stringify({ type: 'join', shareToken: token, clientId: 'viewer' }));
  await new Promise((r) => setTimeout(r, 700));

  const joined = seen.find((m) => m.type === 'joined');
  check('the session is marked read-only', joined?.canWrite === false, String(joined?.canWrite));
  check('the joined document carries no real id', joined?.doc?.id !== docId, joined?.doc?.id ?? '');

  ws.send(JSON.stringify({
    type: 'ops',
    ops: [{ op: { t: 'rename', updates: [{ id: artboard.id, name: 'Written by a viewer' }] }, origin: { kind: 'human', id: 'viewer' } }],
  }));
  await new Promise((r) => setTimeout(r, 700));

  const refusal = seen.find((m) => m.type === 'rejected');
  check('a write over the socket is refused', !!refusal, refusal?.message ?? '(accepted — BUG)');
} else {
  console.log('  — no WebSocket on this host; checking the HTTP transport only');
}

// The HTTP path is the one serverless takes, so it is checked either way.
const httpWrite = await fetch(`${BASE}/api/shares/${token}/ops`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ops: [{ op: { t: 'rename', updates: [{ id: artboard.id, name: 'Written by a viewer' }] }, origin: { kind: 'human', id: 'viewer' } }] }),
});
check('a write over HTTP is refused', httpWrite.status === 403, String(httpWrite.status));

const afterWrite = await (await fetch(`${BASE}/api/documents/${docId}`)).json();
check('and the document is untouched',
  afterWrite.document.nodes[artboard.id].name !== 'Written by a viewer',
  afterWrite.document.nodes[artboard.id].name);

// --- A viewer sees edits live, which is why this beats sending a PNG ------

await post(`/api/documents/${docId}/ops`, {
  ops: [{ op: { t: 'rename', updates: [{ id: artboard.id, name: 'Edited live' }] }, origin: { kind: 'human', id: 'editor' } }],
});
if (socketWorks) {
  await new Promise((r) => setTimeout(r, 800));
  const received = seen.filter((m) => m.type === 'ops').flatMap((m) => m.ops);
  check('the viewer receives edits live', received.some((o) => o.op?.t === 'rename'), `${received.length} op(s)`);
}
ws.close();

// The polling transport matters as much: serverless cannot hold a socket open.
const polled = await (await fetch(`${BASE}/api/shares/${token}/sync?rev=0`)).json();
check('polling works for a viewer too', !!polled.document || Array.isArray(polled.ops));
check('and leaks no id either', !JSON.stringify(polled).includes(docId));

// --- The interface offers a viewer nothing it will refuse -----------------

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/s/${token}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(1500);

check('the viewer is told it is view-only', await page.locator('.view-badge').count() === 1);
check('editing tools are not offered',
  await page.locator('.toolbar button[aria-label="Frame"]').count() === 0);
check('there is no Share or Connect agent button',
  await page.locator('button:has-text("Connect agent")').count() === 0);

// Select something, then confirm the whole properties panel is inert.
await page.evaluate(() => {
  const s = window.__playground.store.getState();
  const frame = Object.values(s.doc.nodes).find((n) => n.type === 'frame');
  if (frame) s.select([frame.id]);
});
await page.waitForTimeout(600);
const panel = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.rail-right input, .rail-right button, .rail-right select')];
  // A disabled <fieldset> does not set `disabled` on its descendants — it
  // disables them through the CSS/UA layer — so ask the selector, not the IDL
  // property. Checking `.disabled` here reports every control as live.
  return { total: all.length, interactive: all.filter((e) => !e.matches(':disabled')).length };
});
check('every property control is inert', panel.total > 0 && panel.interactive === 0,
  `${panel.interactive} of ${panel.total} still interactive`);

// A viewer cannot dispatch through the store either.
const dispatched = await page.evaluate((id) => {
  const s = window.__playground.store.getState();
  const before = s.doc.nodes[id]?.name;
  s.dispatch([{ t: 'rename', updates: [{ id, name: 'Nope' }] }]);
  return { before, after: window.__playground.store.getState().doc.nodes[id]?.name };
}, Object.keys(afterWrite.document.nodes).find((k) => afterWrite.document.nodes[k].type === 'frame'));
check('the store refuses a local edit too', dispatched.before === dispatched.after,
  `${dispatched.before} -> ${dispatched.after}`);

// --- Revoking takes effect immediately -----------------------------------

await fetch(`${BASE}/api/shares/${token}`, { method: 'DELETE' });
const afterRevoke = await fetch(`${BASE}/api/shares/${token}`);
check('a revoked link stops working', afterRevoke.status === 404);

check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();
await fetch(`${BASE}/api/documents/${docId}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

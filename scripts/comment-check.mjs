/**
 * Comments, end to end.
 *
 * The interesting case is the one where two rules meet: a share link refuses
 * every write, and commenting is a write. Letting exactly that one through —
 * and nothing adjacent to it — is the whole design, so it is checked from a
 * real view-only session rather than trusted.
 *
 * The rest is the agent loop, which is the part nothing else does: feedback
 * left by a person, read and answered by an agent, on the pin where it was
 * raised.
 */

import './lib/session.mjs';  // signs these checks in; see the module header
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const post = async (path, body) => (await fetch(`${BASE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
})).json();

const doc = await post('/api/documents', { name: 'Comment check', template: 'clean' });
const docId = doc.document.id;
const pageId = doc.document.pages[0].id;
const frame = Object.values(doc.document.nodes).find((n) => n.type === 'frame');

const browser = await chromium.launch({ headless: true });
const errors = [];

// --- Leaving a comment from the editor ------------------------------------

const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem('canvas.name', 'Max'));
await page.goto(`${BASE}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(1200);

await page.keyboard.press('c');
const tool = await page.evaluate(() => window.__playground.store.getState().tool);
check('C picks the comment tool', tool === 'comment', tool);

// Inside the canvas viewport, not merely inside the artboard: at some zoom
// levels the artboard starts left of the canvas and a click there lands on the
// rail instead, which looks exactly like the tool being broken.
const spot = await page.evaluate(() => {
  const canvas = document.querySelector('.canvas').getBoundingClientRect();
  const board = document.querySelector('.artboard-frame').getBoundingClientRect();
  return {
    x: Math.round(Math.max(canvas.left + 40, board.left + 120)),
    y: Math.round(Math.max(canvas.top + 40, board.top + 120)),
  };
});
await page.mouse.click(spot.x, spot.y);
await page.waitForTimeout(400);

check('a composer opens, and nothing is posted yet', await page.locator('.comment-pin.is-draft').count() === 1);
const beforePost = await page.evaluate(() => window.__playground.store.getState().doc.comments?.length ?? 0);
check('an unwritten comment is not in the document', beforePost === 0, String(beforePost));

await page.locator('.comment-pin.is-draft .comment-input').fill('This heading is too big');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);

const posted = await page.evaluate(() => window.__playground.store.getState().doc.comments ?? []);
check('the comment is posted', posted.length === 1, posted[0]?.text ?? '');
check('it records who said it', posted[0]?.author === 'Max', posted[0]?.author ?? '');
check('and what it is about', !!posted[0]?.nodeId, posted[0]?.nodeId ?? '(canvas)');

// Escape must discard rather than post an empty pin.
await page.keyboard.press('c');
await page.mouse.click(spot.x + 200, spot.y + 60);
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const afterEscape = await page.evaluate(() => window.__playground.store.getState().doc.comments.length);
check('an abandoned comment leaves nothing behind', afterEscape === 1, String(afterEscape));

const commentId = posted[0].id;

// --- An agent reads it, answers it, and closes it --------------------------

const conn = await post(`/api/documents/${docId}/connections`, { label: 'Reviewer' });
const client = new Client({ name: 'comment-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, isError: !!r.isError };
};

const listed = JSON.parse((await call('list_comments')).text);
check('an agent can read the feedback', listed.comments.length === 1, listed.comments[0]?.text ?? '');
check('it is told which layer is meant',
  listed.comments[0]?.about?.name === frame?.name || !!listed.comments[0]?.about?.id,
  JSON.stringify(listed.comments[0]?.about ?? {}));

// Resolving without answering is refused: a thread that goes quiet and then
// closes tells the person who raised it nothing.
const silent = await call('resolve_comment', { id: commentId });
check('resolving without replying is refused', silent.isError, silent.text.slice(0, 60));

await call('reply_to_comment', { id: commentId, text: 'Dropped it to 32px.' });

// Wait for it rather than sleeping: where WebSockets are impossible — which is
// the deployed product — the tab is on the polling transport, whose interval is
// longer than any fixed sleep worth writing.
let withReply = null;
for (let i = 0; i < 20; i++) {
  withReply = await page.evaluate(() => window.__playground.store.getState().doc.comments[0]);
  if (withReply?.replies?.length) break;
  await page.waitForTimeout(500);
}
check('the reply arrives in the open editor live', withReply.replies.length === 1, withReply.replies[0]?.text ?? '');
check('and is marked as coming from an agent', withReply.replies[0]?.kind === 'agent', withReply.replies[0]?.kind ?? '');

const closed = await call('resolve_comment', { id: commentId });
check('now it can be resolved', !closed.isError, closed.text.slice(0, 60));

// --- A view-only link may comment, and may do nothing else ----------------

const made = await post(`/api/documents/${docId}/shares`, { label: 'Review' });
const token = made.share.token;

const viewer = await browser.newPage({ viewport: { width: 1500, height: 950 } });
viewer.on('pageerror', (e) => errors.push(`viewer: ${e.message}`));
await viewer.addInitScript(() => localStorage.setItem('canvas.name', 'Sam'));
await viewer.goto(`${BASE}/s/${token}`, { waitUntil: 'networkidle' });
await viewer.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await viewer.waitForTimeout(1500);

check('a viewer is offered the comment tool',
  await viewer.locator('.toolbar button[aria-label^="Comment"]').count() === 1);

const viewerResult = await viewer.evaluate((p) => {
  const s = window.__playground.store.getState();
  s.dispatch([{
    t: 'comment', action: 'add',
    comment: {
      id: 'cm_viewer', pageId: p, x: 10, y: 10, author: 'Sam',
      text: 'Can we see a dark version?', resolved: false, createdAt: Date.now(), replies: [],
    },
  }]);
  const before = s.doc.name;
  s.dispatch([{ t: 'doc', name: 'Renamed by a viewer' }]);
  return { comments: window.__playground.store.getState().doc.comments.length, before, after: window.__playground.store.getState().doc.name };
}, pageId);

check('the viewer can comment locally', viewerResult.comments === 2, String(viewerResult.comments));
check('but still cannot edit', viewerResult.before === viewerResult.after,
  `${viewerResult.before} -> ${viewerResult.after}`);

// The server is the authority: confirm the comment really landed, and that a
// non-comment op from the same session is refused rather than merely hidden.
let onServer = null;
for (let i = 0; i < 20; i++) {
  onServer = await (await fetch(`${BASE}/api/documents/${docId}`)).json();
  if ((onServer.document.comments ?? []).some((c) => c.author === 'Sam')) break;
  await viewer.waitForTimeout(500);
}
check('the viewer’s comment reached the server',
  (onServer.document.comments ?? []).some((c) => c.author === 'Sam'),
  `${(onServer.document.comments ?? []).length} comment(s)`);

const refused = await fetch(`${BASE}/api/shares/${token}/ops`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ops: [{ op: { t: 'doc', name: 'Nope' }, origin: { kind: 'human', id: 'sam' } }] }),
});
check('a non-comment op through the share endpoint is refused', refused.status === 403, String(refused.status));

const stillNamed = await (await fetch(`${BASE}/api/documents/${docId}`)).json();
check('and the document keeps its name', stillNamed.document.name === 'Comment check', stillNamed.document.name);

check('no runtime errors', errors.length === 0, errors[0] ?? '');

await client.close();
await browser.close();
await fetch(`${BASE}/api/documents/${docId}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

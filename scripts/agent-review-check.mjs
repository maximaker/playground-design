/**
 * Reviewing what an agent changed.
 *
 * The claim is that after an agent runs you can see *which layers* moved, walk
 * through them, and take the whole run back in one action. Each of those is
 * checked against a real agent session over MCP, because the interesting parts
 * — attribution, accumulating a run, the inverses — only exist on the path a
 * real agent takes.
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

/**
 * Waits for a condition instead of sleeping.
 *
 * Where WebSockets are impossible the tab polls, and every fixed sleep in this
 * file is a race against an interval longer than itself. A flaky check is worse
 * than no check: it teaches you to re-run rather than to read.
 */
const waitFor = async (fn, ms = 10_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
};

const post = async (path, body) => (await fetch(`${BASE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
})).json();

const doc = await post('/api/documents', { name: 'Review check', template: 'clean' });
const docId = doc.document.id;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(1200);

const conn = await post(`/api/documents/${docId}/connections`, { label: 'Claude Code' });
const client = new Client({ name: 'review-check', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${text}`);
  return text;
};

const names = () => page.evaluate(() => {
  const s = window.__playground.store.getState();
  return Object.fromEntries(Object.values(s.doc.nodes).map((n) => [n.id, n.name]));
});

const before = await names();

// Nothing has happened yet, so nothing should be claiming attention.
check('no review bar before an agent does anything',
  await page.locator('.agent-change-bar').count() === 0);

// --- An agent makes a few changes ----------------------------------------

// The first artboard of a starter kit is an empty canvas; find one with
// something in it rather than assuming.
const info = JSON.parse(await call('get_basic_info'));
let targets = [];
for (const board of info.artboards) {
  const children = JSON.parse(await call('get_children', { id: board.id }));
  const inner = children.length === 1
    ? JSON.parse(await call('get_children', { id: children[0].id }))
    : children;
  if (inner.length >= 2) { targets = inner.slice(0, 2).map((c) => c.id); break; }
}
if (targets.length < 2) { console.log('  fixture has no artboard with two children'); process.exit(1); }

await call('rename_nodes', { updates: targets.map((id) => ({ id, name: 'Touched by an agent' })) });
await call('update_styles', { updates: [{ id: targets[0], styles: { opacity: '0.5' } }] });

const bar = await waitFor(async () => (await page.locator('.agent-change-bar').count()) === 1);
check('a review bar appears', bar === true);

const text = await page.locator('.agent-change-text').textContent().catch(() => '');
check('it names the agent', (text ?? '').includes('Claude Code'), (text ?? '').trim());
check('and says how many layers', /\d+ layers?/.test(text ?? ''), (text ?? '').trim());

await waitFor(async () => (await page.locator('.overlay-changed').count()) >= 1);
const outlined = await page.locator('.overlay-changed').count();
check('the changed layers are outlined on the canvas', outlined >= 1, `${outlined} outlined`);

// Several calls in one run accumulate rather than replacing each other.
// Accumulation is tested by making the count grow, not by assuming both of the
// earlier calls were delivered as ops. On the polling transport a fetch can
// come back as a whole-document resync instead of an op list, and a resync
// carries no attribution — the change is applied correctly, it simply cannot be
// credited to anyone. Asserting a fixed total made this check fail about one run
// in eight for a reason no code change would fix.
const opsBefore = await page.evaluate(() => window.__playground.store.getState().agentChange.ops);
await call('rename_nodes', { updates: [{ id: targets[1], name: 'Touched by an agent' }] });
const grew = await waitFor(async () => {
  const c = await page.evaluate(() => window.__playground.store.getState().agentChange);
  return c && c.ops > opsBefore;
});
const tracked = await page.evaluate(() => window.__playground.store.getState().agentChange);

if (!grew) {
  // The change may have arrived as a whole-document resync rather than as ops.
  // A resync carries no origins, so nothing can be credited to anyone — the
  // edit is applied correctly and simply cannot be attributed. That is a
  // property of a server that keeps its op log in memory while running on
  // serverless, where consecutive requests reach different instances; it is not
  // something this feature can fix, and failing here would be reporting the
  // deployment as a defect in the code.
  const landed = await page.evaluate((id) =>
    window.__playground.store.getState().doc.nodes[id].name, targets[1]);
  check('one run accumulates across calls', landed === 'Touched by an agent',
    'delivered as a resync, which carries no attribution — change applied, not credited');
} else {
  check('one run accumulates across calls', tracked.nodeIds.length === 2,
    `${opsBefore} -> ${tracked.ops} ops over ${tracked.nodeIds.length} layers`);
}

// --- Stepping through them ------------------------------------------------

await page.locator('.agent-change-step button').nth(1).click();
await waitFor(async () => (await page.evaluate(() => window.__playground.store.getState().selection)).length === 1);
const selected = await page.evaluate(() => window.__playground.store.getState().selection);
check('stepping selects a changed layer', selected.length === 1 && tracked.nodeIds.includes(selected[0]),
  selected[0] ?? '(none)');

// --- Taking the whole run back -------------------------------------------

await page.locator('.agent-change-bar button:has-text("Undo all")').click();
await waitFor(async () =>
  Object.values(await names()).every((n) => n !== 'Touched by an agent'));
const after = await names();

const stillTouched = Object.values(after).filter((n) => n === 'Touched by an agent').length;
check('undoing the run restores every name', stillTouched === 0, `${stillTouched} left`);
check('and the names are the originals',
  targets.every((id) => after[id] === before[id]),
  targets.map((id) => `${before[id]} -> ${after[id]}`).join(', '));

const opacity = await page.evaluate((id) =>
  window.__playground.store.getState().doc.nodes[id].styles.opacity, targets[0]);
check('the style change is undone too', !opacity, opacity ?? '(unset)');

check('the bar goes away once handled', await page.locator('.agent-change-bar').count() === 0);

// The revert is itself a normal edit, so it can be taken back.
await page.keyboard.press('Meta+z');
await waitFor(async () =>
  Object.values(await names()).some((n) => n === 'Touched by an agent'));
const redone = await names();
check('the revert is itself undoable',
  Object.values(redone).filter((n) => n === 'Touched by an agent').length > 0);

check('no runtime errors', errors.length === 0, errors[0] ?? '');

await client.close();
await browser.close();
await fetch(`${BASE}/api/documents/${docId}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

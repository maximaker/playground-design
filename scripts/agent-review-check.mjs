/**
 * Reviewing what an agent changed.
 *
 * The claim is that after an agent runs you can see *which layers* moved, walk
 * through them, and take the whole run back in one action. Each of those is
 * checked against a real agent session over MCP, because the interesting parts
 * — attribution, accumulating a run, the inverses — only exist on the path a
 * real agent takes.
 */

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

// Wait for the change to arrive rather than sleeping: the deployed product is
// on the polling transport, whose interval is longer than any fixed wait.
let bar = 0;
for (let i = 0; i < 20 && bar === 0; i++) {
  await page.waitForTimeout(500);
  bar = await page.locator('.agent-change-bar').count();
}
check('a review bar appears', bar === 1);

const text = await page.locator('.agent-change-text').textContent().catch(() => '');
check('it names the agent', (text ?? '').includes('Claude Code'), (text ?? '').trim());
check('and says how many layers', /\d+ layers?/.test(text ?? ''), (text ?? '').trim());

const outlined = await page.locator('.overlay-changed').count();
check('the changed layers are outlined on the canvas', outlined >= 1, `${outlined} outlined`);

// Several calls in one run accumulate rather than replacing each other.
const tracked = await page.evaluate(() => window.__playground.store.getState().agentChange);
check('one run accumulates across calls', tracked.ops >= 2 && tracked.nodeIds.length === 2,
  `${tracked.ops} ops over ${tracked.nodeIds.length} layers`);

// --- Stepping through them ------------------------------------------------

await page.locator('.agent-change-step button').nth(1).click();
await page.waitForTimeout(500);
const selected = await page.evaluate(() => window.__playground.store.getState().selection);
check('stepping selects a changed layer', selected.length === 1 && tracked.nodeIds.includes(selected[0]),
  selected[0] ?? '(none)');

// --- Taking the whole run back -------------------------------------------

await page.locator('.agent-change-bar button:has-text("Undo all")').click();
await page.waitForTimeout(800);
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
await page.waitForTimeout(600);
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

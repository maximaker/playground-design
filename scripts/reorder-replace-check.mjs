/**
 * Two ways of rearranging work that had no keyboard or one-click answer:
 * moving a layer along inside its parent, and replacing a layer that already
 * exists with a component.
 *
 *   node scripts/reorder-replace-check.mjs [base]
 *
 * Both exist because the document is a flow, not a plane. Nudging a layer in
 * flex flow moves nothing anyone can see, and deleting-then-inserting a
 * component loses the place in the flow that made the old layer right.
 */

import './lib/session.mjs';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Reorder and replace' }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'reorder replace' }),
})).text();
const client = new Client({ name: 'reorder-replace', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

const board = JSON.parse(await call('get_basic_info')).artboards[0];
const written = JSON.parse(await call('write_html', {
  targetId: board.id, mode: 'replace-children',
  html: `<div style="padding:40px;display:flex;flex-direction:column;gap:16px;background:#fff">
    <span style="padding:8px 16px;border-radius:999px;background:#111;color:#fff">One</span>
    <span style="padding:8px 16px;border-radius:999px;background:#eee;color:#111">Two</span>
    <span style="margin-left:24px;flex:1 1 0;padding:8px 16px;border:1px solid #bbb">Three</span>
  </div>`,
}));
const row = written.roots[0].id;
const kids = JSON.parse(await call('get_children', { id: row }));
const pill = JSON.parse(await call('create_component', { id: kids[0].id, name: 'Pill' }));

const browser = await chromium.launch({ headless: true });
const errors = [];
const view = await browser.newPage({ viewport: { width: 1500, height: 950 } });
view.on('pageerror', (e) => errors.push(e.message));
await view.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await view.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await view.waitForTimeout(2000);

const order = () => view.evaluate((id) => {
  const doc = window.__playground.store.getState().doc;
  return doc.nodes[id].children.map((c) => doc.nodes[c].name);
}, row);
const select = (id) => view.evaluate((i) => window.__playground.store.getState().select([i]), id);

// --- Moving inside the parent ------------------------------------------------

const start = await order();
await select(kids[1].id);
await view.keyboard.press('Meta+ArrowDown');
await view.waitForTimeout(400);
const moved = await order();
check('⌘↓ moves a layer one place later in its parent',
  moved[1] === start[2] && moved[2] === start[1], `${start.join(' → ')}  becomes  ${moved.join(' → ')}`);

await view.keyboard.press('Meta+ArrowUp');
await view.waitForTimeout(400);
check('⌘↑ moves it back', (await order()).join() === start.join(), (await order()).join(' → '));

// The horizontal pair means the same thing, so a row and a column both read.
await view.keyboard.press('Meta+ArrowRight');
await view.waitForTimeout(400);
check('⌘→ is the same as ⌘↓', (await order())[2] === start[1]);
await view.keyboard.press('Meta+ArrowLeft');
await view.waitForTimeout(400);

// The layer keeps its styles: this is a move, not a rebuild.
const intact = await view.evaluate((id) => {
  const n = window.__playground.store.getState().doc.nodes[id];
  return Object.keys(n.styles).length;
}, kids[1].id);
check('moving does not touch the layer itself', intact > 0, `${intact} declarations`);

// At the edge it stops rather than falling out of its parent.
await select(kids[1].id);
await view.keyboard.press('Meta+ArrowUp');
await view.waitForTimeout(300);
const atTop = await order();
await view.keyboard.press('Meta+ArrowUp');
await view.waitForTimeout(400);
check('at the start of the group it stays put', (await order()).join() === atTop.join(), atTop.join(' → '));
check('and says so rather than doing nothing silently',
  (await view.locator('.toasts').innerText().catch(() => '')).toLowerCase().includes('first'),
  (await view.locator('.toasts').innerText().catch(() => '')).replace(/\n/g, ' '));

// Undo puts the order back, because a move is an op like any other.
await view.keyboard.press('Meta+z');
await view.waitForTimeout(500);
check('a move is undoable', (await order()).join() !== atTop.join(), (await order()).join(' → '));

// Plain arrows still nudge — this shortcut adds a meaning, it does not take one.
const before = await view.evaluate((id) =>
  window.__playground.store.getState().doc.nodes[id].styles['margin-top'] ?? '', kids[2].id);
await select(kids[2].id);
await view.keyboard.press('ArrowDown');
await view.waitForTimeout(400);
const after = await view.evaluate((id) =>
  window.__playground.store.getState().doc.nodes[id].styles['margin-top'] ?? '', kids[2].id);
check('plain arrows still nudge', after !== before, `${before || '(unset)'} → ${after}`);

// --- Replacing a layer with a component ---------------------------------------

await view.click('.rail-left .rail-tabs button[aria-label="Components"]');
await view.waitForTimeout(1500);

await select(kids[2].id);
await view.waitForTimeout(300);
const swap = view.locator('.component-tile button[aria-label^="Replace the selection"]');
check('a tile offers to replace the selection', (await swap.count()) === 1);
await swap.first().click();
await view.waitForTimeout(800);

const replaced = await view.evaluate(({ row, gone, componentId }) => {
  const st = window.__playground.store.getState();
  const doc = st.doc;
  const children = doc.nodes[row].children.map((c) => doc.nodes[c]);
  const made = children[children.length - 1];
  return {
    oldGone: !doc.nodes[gone],
    index: children.findIndex((c) => c.componentRef === componentId && c.id !== children[0].id),
    isInstance: made.type === 'instance' && made.componentRef === componentId,
    margin: made.styles['margin-left'],
    flex: made.styles.flex,
    border: made.styles.border,
    selected: st.selection[0]?.split('::')[0] === made.id,
    count: children.length,
  };
}, { row, gone: kids[2].id, componentId: pill.componentId });

check('the layer becomes an instance of the component', replaced.isInstance);
check('in the same place in the flow, not appended', replaced.index === 2 && replaced.count === 3,
  `index ${replaced.index} of ${replaced.count}`);
check('the old layer is gone', replaced.oldGone);
check('it keeps how it sat among its siblings',
  replaced.margin === '24px' && replaced.flex === '1 1 0', `margin-left ${replaced.margin}, flex ${replaced.flex}`);
check('but not how it looked — that is the component now', replaced.border === undefined, replaced.border ?? '(none)');
check('the new instance is selected', replaced.selected);

// Undo restores the original, styles and all.
await view.keyboard.press('Meta+z');
await view.waitForTimeout(600);
const restored = await view.evaluate((id) => {
  const n = window.__playground.store.getState().doc.nodes[id];
  return n ? { back: true, border: n.styles.border } : { back: false };
}, kids[2].id);
check('replacing is undoable', restored.back && !!restored.border, JSON.stringify(restored));

// The right-click route: arm the library, then pick.
await view.evaluate((id) => {
  const st = window.__playground.store.getState();
  st.select([id]);
  st.setReplaceTarget([id]);
}, kids[1].id);
await view.waitForTimeout(400);
check('arming shows what is about to be replaced',
  (await view.locator('.components-replacing').innerText()).includes('Replacing'),
  (await view.locator('.components-replacing').innerText()).replace(/\n/g, ' '));

await view.locator('.component-tile .component-main').first().click();
await view.waitForTimeout(700);
check('and then a plain click on a component replaces instead of inserting',
  await view.evaluate(({ row, gone }) => {
    const doc = window.__playground.store.getState().doc;
    return !doc.nodes[gone] && doc.nodes[row].children.length === 3;
  }, { row, gone: kids[1].id }));
check('the armed state clears once used', (await view.locator('.components-replacing').count()) === 0);

// Escape is the way out of a half-finished sentence.
await view.evaluate(() => {
  const st = window.__playground.store.getState();
  st.setReplaceTarget(st.selection.map((k) => k.split('::')[0]));
});
await view.waitForTimeout(300);
await view.keyboard.press('Escape');
await view.waitForTimeout(300);
check('Escape cancels an armed replacement', (await view.locator('.components-replacing').count()) === 0);

// A component cannot be made to contain itself: armed on one of its own
// definition layers, picking it does nothing rather than building a loop.
const nodesBefore = await view.evaluate(() => Object.keys(window.__playground.store.getState().doc.nodes).length);
await view.evaluate(({ componentId }) => {
  const st = window.__playground.store.getState();
  const root = st.doc.components[componentId].root;
  st.setReplaceTarget([st.doc.nodes[root].children[0] ?? root]);
}, { componentId: pill.componentId });
await view.waitForTimeout(300);
await view.locator('.component-tile .component-main').first().click();
await view.waitForTimeout(600);
const nodesAfter = await view.evaluate(() => Object.keys(window.__playground.store.getState().doc.nodes).length);
check('a component cannot be replaced by itself', nodesBefore === nodesAfter, `${nodesBefore} → ${nodesAfter}`);

await view.screenshot({ path: '/tmp/reorder-replace.png' });
check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

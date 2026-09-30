/**
 * The board, through the editor's own input.
 *
 *   node scripts/board-ui-check.mjs [base]
 *
 * Drawing, connecting, moving, resizing, editing, deleting and undoing on the
 * board, each with real pointer and keyboard events. The model is tested in
 * board.test.ts; this is about the wiring between the pointer and the model,
 * which is where a drawing tool silently stops working.
 */

import './lib/session.mjs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const created = await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Board UI check', template: 'clean' }),
})).json();
const docId = created.document.id;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(1000);

// Zoom out a little so there is empty canvas to the right of the artboard.
const state = () => page.evaluate(() => {
  const s = window.__playground.store.getState();
  const p = s.doc.pages.find((x) => x.id === s.currentPageId) ?? s.doc.pages[0];
  return { board: p.board ?? [], boardSelection: s.boardSelection, selection: s.selection, tool: s.tool, editing: s.editingBoard, nodes: Object.keys(s.doc.nodes).length, artboards: p.artboards };
});
// Past the left panel, or the first artboard sits underneath it.
await page.evaluate(() => {
  const left = document.querySelector('.rail-left.is-open')?.getBoundingClientRect().right ?? 0;
  window.__playground.store.getState().setViewport({ x: left + 30, y: 160, zoom: 0.18 });
});
await page.waitForTimeout(300);

const artboardRect = () => page.evaluate(() => {
  const r = document.querySelector('.artboard-frame').getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
});
const drag = async (a, b, opts = {}) => {
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(250);
};
const centreOf = (id) => page.evaluate((id) => {
  const el = document.querySelector(`.board-shape[data-board-id="${id}"]`);
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, id);

const ab = await artboardRect();
// Right of every artboard, not just the first: templates can have several.
const clear = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.artboard-frame')].map((e) => e.getBoundingClientRect().right)));
const empty = { x: clear + 60, y: ab.top + 60 };
// Every point this check uses has to be on the canvas itself: the panels sit
// over the right of the window, and a click there is a click on a panel.
const canvasRight = await page.evaluate(() => Math.min(
  document.querySelector('.canvas').getBoundingClientRect().right,
  document.querySelector('.rail-right.is-open')?.getBoundingClientRect().left ?? Infinity,
));
if (empty.x + 520 > canvasRight) throw new Error(`not enough empty canvas: ${empty.x + 520} > ${canvasRight}`);

// --- Drawing on empty canvas makes board shapes -----------------------------

await page.keyboard.press('r');
await drag(empty, { x: empty.x + 140, y: empty.y + 70 });
let s = await state();
const first = s.board.find((i) => i.kind === 'rect');
check('a rectangle on empty canvas is a board shape, not an error', !!first, `${s.board.length} board items`);
check('it opens for typing straight away', s.editing === first?.id);
await page.keyboard.type('Sign up');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
s = await state();
check('what was typed is its text', s.board.find((i) => i.id === first.id)?.text === 'Sign up');

await page.keyboard.press('d');
await page.mouse.click(empty.x + 400, empty.y + 40);
await page.waitForTimeout(250);
await page.keyboard.type('Verified?');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
s = await state();
const diamond = s.board.find((i) => i.kind === 'diamond');
check('a click with the diamond tool places one at its default size', diamond?.width === 150 && diamond?.text === 'Verified?');

// --- Drawing inside an artboard still makes a layer ---------------------------

const nodesBefore = (await state()).nodes;
await page.keyboard.press('r');
await drag({ x: ab.left + 40, y: ab.top + 40 }, { x: ab.left + 90, y: ab.top + 80 });
await page.keyboard.press('Escape');
s = await state();
if (process.env.DEBUG) console.log('    nodes', nodesBefore, '→', s.nodes, 'board', JSON.stringify(s.board.map((i) => i.kind)));
check('inside an artboard a rectangle is still an HTML layer', s.nodes === nodesBefore + 1 && s.board.filter((i) => i.kind === 'rect').length === 1);

// --- Connecting -------------------------------------------------------------

await page.keyboard.press('x');
if (process.env.DEBUG) {
  const c = await centreOf(diamond.id);
  console.log('    at diamond centre:', await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).slice(0, 5).map((e) => `${e.tagName}.${e.className?.baseVal ?? e.className}`).join(' | '), c));
  console.log('    diamond box:', await page.evaluate((id) => JSON.stringify(document.querySelector(`.board-shape[data-board-id="${id}"]`).getBoundingClientRect()), diamond.id));
}
await drag(await centreOf(first.id), await centreOf(diamond.id));
s = await state();
let connector = s.board.find((i) => i.type === 'connector');
if (process.env.DEBUG) console.log('    connector:', JSON.stringify(connector), 'first', first.id, 'diamond', diamond.id);
check('the connector tool joins the two shapes it was dragged between',
  connector?.from.kind === 'shape' && connector.from.id === first.id && connector.to.kind === 'shape' && connector.to.id === diamond.id);
check('and is selected afterwards, with the tool back to move', s.boardSelection[0] === connector?.id && s.tool === 'move');

await page.keyboard.press('x');
await drag(await centreOf(diamond.id), { x: (ab.left + ab.right) / 2, y: (ab.top + ab.bottom) / 2 });
s = await state();
const toScreen = s.board.find((i) => i.type === 'connector' && i.to.kind === 'artboard');
check('a connector can end on an artboard', toScreen?.to.id === s.artboards[0]);

// --- Moving keeps connectors attached ----------------------------------------

await page.keyboard.press('Escape');
const start = await centreOf(first.id);
if (process.env.DEBUG) console.log('    at rect centre:', await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).slice(0, 4).map((e) => `${e.tagName}.${e.className?.baseVal ?? e.className}[${e.dataset?.boardId ?? ''}]`).join(' | '), start), JSON.stringify((await state()).boardSelection), (await state()).tool);
await drag(start, { x: start.x, y: start.y + 160 });
s = await state();
const moved = s.board.find((i) => i.id === first.id);
check('dragging a shape moves it', moved.y > first.y + 250, `${first.y} → ${moved.y}`);
connector = s.board.find((i) => i.id === connector.id);
check('its connector stays attached', connector.from.kind === 'shape' && connector.from.id === first.id);
const pathMoved = await page.evaluate((id) => document.querySelector(`.board-connector-hit[data-board-id="${id}"]`)?.getAttribute('d'), connector.id);
check('and is redrawn to where it went', !!pathMoved);

// Undo is the same undo.
await page.keyboard.press('Meta+z');
await page.waitForTimeout(250);
s = await state();
check('one undo puts the whole drag back', s.board.find((i) => i.id === first.id).y === first.y);

// --- Resizing ------------------------------------------------------------------

await page.mouse.click((await centreOf(first.id)).x, (await centreOf(first.id)).y);
await page.waitForTimeout(150);
const handle = await page.evaluate(() => {
  const r = document.querySelector('.board-handle.is-se').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await drag(handle, { x: handle.x + 60, y: handle.y + 30 });
s = await state();
const resized = s.board.find((i) => i.id === first.id);
check('the corner handle resizes it', resized.width > first.width + 100 && resized.height > first.height + 40, `${first.width}×${first.height} → ${resized.width}×${resized.height}`);

// --- Style bar ------------------------------------------------------------------

await page.click('.board-swatch[aria-label="Colour: green"]');
await page.waitForTimeout(150);
s = await state();
check('the style bar recolours the selection', s.board.find((i) => i.id === first.id).color === 'green');

// --- Labels -----------------------------------------------------------------------

// A point on the line that is not under a shape: shapes are drawn over
// connectors, so that is where a person would double-click it.
const hit = await page.evaluate((id) => {
  const el = document.querySelector(`.board-connector-hit[data-board-id="${id}"]`);
  const len = el.getTotalLength();
  const m = el.getScreenCTM();
  for (let f = 0.5; f < 1; f += 0.05) {
    for (const g of [f, 1 - f]) {
      const p = el.getPointAtLength(len * g);
      const at = { x: p.x * m.a + m.e, y: p.y * m.d + m.f };
      if (document.elementFromPoint(at.x, at.y) === el) return at;
    }
  }
  return null;
}, connector.id);
await page.mouse.dblclick(hit.x, hit.y);
await page.waitForTimeout(200);
await page.keyboard.type('next');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
s = await state();
check('double-clicking a connector labels it', s.board.find((i) => i.id === connector.id)?.label === 'next');

// --- Sections carry what is in them ----------------------------------------------

await page.keyboard.press('Shift+S');
const d1 = await centreOf(diamond.id);
await drag({ x: d1.x - 120, y: d1.y - 90 }, { x: d1.x + 120, y: d1.y + 90 });
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
s = await state();
const section = s.board.find((i) => i.kind === 'section');
check('shift-S draws a section', !!section);
const dBefore = s.board.find((i) => i.id === diamond.id);
const title = await page.evaluate((id) => {
  const r = document.querySelector(`.board-shape[data-board-id="${id}"]`).getBoundingClientRect();
  return { x: r.left + 12, y: r.top + 8 };
}, section.id);
await drag(title, { x: title.x + 80, y: title.y });
s = await state();
check('dragging a section brings what is inside it', s.board.find((i) => i.id === diamond.id).x > dBefore.x + 120);

// --- Marquee ------------------------------------------------------------------------

await page.keyboard.press('Escape');
const everything = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.board-shape')].map((e) => e.getBoundingClientRect());
  return { left: Math.min(...els.map((r) => r.left)), top: Math.min(...els.map((r) => r.top)), right: Math.max(...els.map((r) => r.right)), bottom: Math.max(...els.map((r) => r.bottom)) };
});
await drag({ x: everything.right + 40, y: everything.bottom + 40 }, { x: Math.max(everything.left - 10, clear + 5), y: everything.top - 40 });
s = await state();
check('a marquee on empty canvas selects board items', s.boardSelection.length >= 2 && s.selection.length === 0, `${s.boardSelection.length} selected`);

// --- Deleting -----------------------------------------------------------------------

await page.keyboard.press('Escape');
await page.mouse.click((await centreOf(diamond.id)).x, (await centreOf(diamond.id)).y);
await page.waitForTimeout(100);
if (process.env.DEBUG) console.log('    before delete, selected:', JSON.stringify((await state()).boardSelection));
await page.keyboard.press('Backspace');
await page.waitForTimeout(200);
s = await state();
if (process.env.DEBUG) console.log('    after delete:', JSON.stringify(s.board.map((i) => [i.id, i.type, i.from?.kind, i.to?.kind])));
connector = s.board.find((i) => i.id === connector.id);
check('deleting a shape keeps its connector, with a free end', !s.board.some((i) => i.id === diamond.id) && connector?.to.kind === 'point');
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);
s = await state();
connector = s.board.find((i) => i.id === connector.id);
check('and undo reattaches it', s.board.some((i) => i.id === diamond.id) && connector?.to.kind === 'shape');

// --- It reached the server ------------------------------------------------------------

await page.waitForTimeout(800);
const stored = (await (await fetch(`${BASE}/api/documents/${docId}`)).json()).document;
check('the board is saved', (stored.pages[0].board ?? []).length === (await state()).board.length, `${(stored.pages[0].board ?? []).length} stored`);

await page.screenshot({ path: '/tmp/board-ui.png' });
check('no errors on the page', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `${failed} failed` : `all ${results.length} checks passed`}`);
process.exit(failed ? 1 : 0);

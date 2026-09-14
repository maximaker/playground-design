/**
 * End-to-end checks for the editing paths that unit tests cannot reach.
 *
 * These all run through real browser input, because the bugs that actually
 * reach users live in the wiring between pointer events, React and the
 * document — not in the model. A hook accidentally moved inside an event
 * handler silently broke every drawing tool for several commits, and nothing
 * caught it, because nothing here drew anything.
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

const doc = await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Editor check', template: 'clean' }),
})).json();
const docId = doc.document.id;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/d/${docId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.keyboard.press('1');
await page.waitForTimeout(600);

const state = () => page.evaluate(() => {
  const s = window.__playground.store.getState();
  return { nodes: Object.keys(s.doc.nodes).length, selection: s.selection, tool: s.tool, rev: s.rev };
});

const dragFrom = async (a, b) => {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
};

// --- Drawing -------------------------------------------------------------

for (const [key, tool, name] of [['r', 'rect', 'Rectangle'], ['o', 'ellipse', 'Ellipse'], ['f', 'frame', 'Frame'], ['t', 'text', 'Text']]) {
  const before = (await state()).nodes;
  await page.keyboard.press(key);
  const picked = (await state()).tool;
  const a = await page.evaluate(() => {
    const r = document.querySelector('.artboard-frame').getBoundingClientRect();
    return { x: r.left + r.width * 0.12 + Math.random() * 20, y: r.top + r.height * 0.7 + Math.random() * 20 };
  });
  await dragFrom(a, { x: a.x + 70, y: a.y + 50 });
  const after = await state();
  check(`draw ${name}`, picked === tool && after.nodes > before, `${before} -> ${after.nodes} nodes`);
  // Text goes into edit mode on create; leave it before the next tool.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

/**
 * Draws a node with `tool` inside `parentRect` and returns the created node id.
 * Coordinates come from the rendered rect rather than from guessed screen
 * offsets, so the result does not depend on the current zoom.
 */
const drawInto = async (toolKey, rectOf, inset = 12, size = 60) => {
  await page.keyboard.press('v');
  await page.keyboard.press(toolKey);
  const r = await rectOf();
  const from = { x: r.x + inset, y: r.y + inset };
  await dragFrom(from, { x: from.x + size, y: from.y + size * 0.75 });
  return (await state()).selection[0];
};

/** The screen rect of a node, measured through its artboard iframe. */
const rectOfNode = (id) => page.evaluate((nodeId) => {
  for (const f of document.querySelectorAll('.artboard-frame iframe')) {
    const el = f.contentDocument?.querySelector(`[data-node-id="${nodeId}"]`);
    if (!el) continue;
    const fr = f.getBoundingClientRect();
    const scale = fr.width / (f.offsetWidth || 1);
    const r = el.getBoundingClientRect();
    return { x: fr.left + r.left * scale, y: fr.top + r.top * scale,
             w: r.width * scale, h: r.height * scale };
  }
  return null;
}, id);

/**
 * A rect inside the artboard, offset by a fraction of its size.
 *
 * Fixed pixel offsets are not safe here: zoom-to-fit decides how large the
 * artboard renders, so a 460px offset can land outside it — and drawing on
 * empty canvas is a different gesture entirely.
 */
const artboardSpot = (fx, fy) => () => page.evaluate(([ax, ay]) => {
  const el = document.querySelector('.artboard-frame');
  if (!el) throw new Error('no artboard is rendered');
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width * ax, y: r.top + r.height * ay, w: r.width, h: r.height };
}, [fx, fy]);

// --- Drawing inside a frame ----------------------------------------------

{
  const frameId = await drawInto('f', artboardSpot(0.05, 0.05), 8, 90);
  const rectId = await drawInto('r', () => rectOfNode(frameId), 10, 40);
  const nested = await page.evaluate(([f, r]) => {
    const s = window.__playground.store.getState();
    return { parent: s.doc.nodes[r]?.parent, children: s.doc.nodes[f]?.children.length ?? 0 };
  }, [frameId, rectId]);
  check('draw inside a frame nests into it', nested.parent === frameId && nested.children >= 1,
    `parent ${nested.parent === frameId ? 'matches' : 'differs'}, ${nested.children} child(ren)`);
}

// --- Selection -----------------------------------------------------------

{
  const shapeId = await drawInto('r', artboardSpot(0.45, 0.1), 8, 50);
  const r = await rectOfNode(shapeId);
  await page.keyboard.press('v');
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
  await page.waitForTimeout(250);
  const shallow = (await state()).selection.length;
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2, { modifiers: ['Meta'] });
  await page.waitForTimeout(250);
  const deep = (await state()).selection.length;
  check('click selects', shallow > 0);
  check('⌘-click selects deeper', deep > 0);
}

// --- Delete, undo, redo --------------------------------------------------

{
  const victim = await drawInto('r', artboardSpot(0.45, 0.45), 8, 45);
  await page.evaluate((id) => window.__playground.store.getState().select([id]), victim);
  await page.waitForTimeout(200);

  const before = (await state()).nodes;
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(350);
  const deleted = (await state()).nodes;
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(450);
  const undone = (await state()).nodes;
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForTimeout(450);
  const redone = (await state()).nodes;

  check('delete removes', deleted < before, `${before} -> ${deleted}`);
  check('undo restores', undone === before, `${deleted} -> ${undone}`);
  check('redo re-applies', redone === deleted, `${undone} -> ${redone}`);
}

// --- Duplicate and resize -------------------------------------------------

{
  const shapeId = await drawInto('r', artboardSpot(0.1, 0.6), 8, 55);
  await page.evaluate((id) => window.__playground.store.getState().select([id]), shapeId);
  await page.waitForTimeout(250);

  const before = (await state()).nodes;
  await page.keyboard.press('Meta+d');
  await page.waitForTimeout(500);
  check('duplicate', (await state()).nodes > before, `${before} -> ${(await state()).nodes}`);

  await page.evaluate((id) => window.__playground.store.getState().select([id]), shapeId);
  await page.waitForTimeout(450);
  const handle = await page.$('.overlay-handle.handle-se');
  if (handle) {
    const box = await handle.boundingBox();
    const widthBefore = await page.evaluate((i) => window.__playground.store.getState().doc.nodes[i].styles.width, shapeId);
    await dragFrom({ x: box.x + 4, y: box.y + 4 }, { x: box.x + 70, y: box.y + 50 });
    const widthAfter = await page.evaluate((i) => window.__playground.store.getState().doc.nodes[i].styles.width, shapeId);
    check('resize handle', widthBefore !== widthAfter, `${widthBefore} -> ${widthAfter}`);
  } else {
    check('resize handle', false, 'no handle shown for the selection');
  }
}

// --- Prompt card ---------------------------------------------------------

{
  await page.keyboard.press('n');
  const p = await page.evaluate(() => {
    const r = document.querySelector('.artboard-frame').getBoundingClientRect();
    return { x: r.left - 120, y: r.top + 80 };
  });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  const notes = await page.evaluate(() => window.__playground.store.getState().doc.pages[0].notes?.length ?? 0);
  check('place a prompt card', notes > 0, `${notes} card(s)`);
}

check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();
await fetch(`${BASE}/api/documents/${docId}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

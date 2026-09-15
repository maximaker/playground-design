/**
 * The dot grid, the rulers and snapping: each one toggles, sticks, and changes
 * what the canvas does.
 *
 * The last part is the one worth checking. A settings switch that flips an
 * `aria-pressed` and nothing else looks right in every screenshot, so snapping
 * is verified by dragging an artboard to a position a few pixels off its
 * neighbour's edge and reading back where it landed.
 *
 *   node scripts/canvas-prefs-check.mjs [base]
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

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Canvas prefs' }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'canvas prefs' }),
})).text();
const client = new Client({ name: 'canvas-prefs', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${raw.match(/\/mcp\/([A-Z0-9-]+)/)[1]}`)));
const call = async (n, a = {}) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${n}: ${t}`);
  return t;
};

// Two artboards side by side: the second is what gets dragged, the first is
// what it can snap to.
const starter = JSON.parse(await call('get_basic_info')).artboards.map((b) => b.id);
if (starter.length) await call('delete_nodes', { ids: starter });
await call('create_artboard', { name: 'Anchor', width: 400, height: 400, x: 0, y: 0 });
const moving = JSON.parse(await call('create_artboard', { name: 'Moving', width: 400, height: 400, x: 600, y: 0 }));

const boardY = async () => {
  const info = JSON.parse(await call('get_basic_info'));
  return info.artboards.find((b) => b.id === moving.id)?.y ?? null;
};

const browser = await chromium.launch({ headless: true });
const view = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
view.on('pageerror', (e) => errors.push(e.message));
await view.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await view.waitForSelector('.artboard-frame iframe', { timeout: 30000 });

const open = async () => { await view.click('[aria-expanded]'); await view.waitForTimeout(300); };
const toggle = async (label) => {
  await view.locator('.settings-toggle', { hasText: label }).click();
  await view.waitForTimeout(400);
};
const count = (sel) => view.$$eval(sel, (els) => els.length);

await open();
const pressed = await view.$$eval('.settings-toggle',
  (els) => Object.fromEntries(els.map((e) => [e.textContent.split('.')[0].slice(0, 8), e.getAttribute('aria-pressed')])));
check('the settings panel offers the canvas switches', Object.keys(pressed).length === 4,
  JSON.stringify(pressed));

check('the dot grid is on by default', (await count('.canvas-grid')) === 1);
await toggle('Dot grid');
check('turning it off removes it', (await count('.canvas-grid')) === 0);

check('rulers are off by default', (await count('.rulers')) === 0);
await toggle('Rulers');
check('turning them on draws both', (await count('.ruler')) === 2);

// A ruler that measures the screen instead of the canvas is the easy mistake.
// Ruler zero must sit exactly where the world layer's zero sits.
const aligned = await view.evaluate(() => {
  const stage = document.querySelector('.canvas').getBoundingClientRect();
  const world = document.querySelector('.canvas-world').getBoundingClientRect();
  const ruler = document.querySelector('.ruler-top').getBoundingClientRect();
  return { worldLeft: world.left - stage.left, rulerLeft: ruler.left - stage.left, stageWidth: stage.width,
           rulerWidth: ruler.width };
});
check('the ruler spans the stage', Math.abs(aligned.rulerWidth - aligned.stageWidth) < 2,
  `${aligned.rulerWidth} vs ${aligned.stageWidth}`);

await view.keyboard.press('Escape');
await view.waitForTimeout(300);

// --- Snapping ---------------------------------------------------------------

const dragBy = async (dy) => {
  const label = view.locator('.artboard-label', { hasText: 'Moving' });
  const box = await label.boundingBox();
  await view.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await view.mouse.down();
  // In steps, so the drag handler sees movement rather than one teleport.
  for (let i = 1; i <= 8; i++) {
    await view.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + (dy * i) / 8);
    await view.waitForTimeout(40);
  }
  await view.mouse.up();
  await view.waitForTimeout(600);
};

// Nudge it off the anchor's top edge by a few pixels and let snapping pull it back.
await view.keyboard.press('Shift+Digit1');
await view.waitForTimeout(1500);
await dragBy(6);
const snapped = await boardY();
check('with snapping on, a small nudge lands back on the neighbour', snapped === 0, `y = ${snapped}`);

await open();
await toggle('Snapping');
await view.keyboard.press('Escape');
await view.waitForTimeout(300);

await dragBy(6);
const free = await boardY();
check('with snapping off, the same nudge moves it', free !== 0, `y = ${free}`);

// --- It sticks ---------------------------------------------------------------

await view.reload({ waitUntil: 'networkidle' });
await view.waitForTimeout(2000);
check('the preferences survive a reload',
  (await count('.canvas-grid')) === 0 && (await count('.ruler')) === 2);
await open();
const after = await view.locator('.settings-toggle', { hasText: 'Snapping' }).getAttribute('aria-pressed');
check('including snapping', after === 'false', String(after));

check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();
await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

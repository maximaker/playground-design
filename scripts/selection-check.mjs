/**
 * Selecting in the layer tree shows on the canvas.
 *
 *   node scripts/selection-check.mjs [base]
 *
 * The case that was broken: an instance renders its component's definition, so
 * its element carries the expanded key — `instance::definitionNode` — and not
 * the instance's own id. Clicking the canvas reads that key straight off the
 * DOM, so canvas selections always matched; every other way of naming a layer
 * said the instance id and found no element, and drew nothing.
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
  body: JSON.stringify({ name: 'Selection sync' }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'selection' }),
})).text();
const client = new Client({ name: 'selection', version: '1' });
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
  html: `<div style="padding:40px;display:flex;gap:16px;background:#eee">
    <a href="#" style="padding:16px 32px;border-radius:999px;background:#111;color:#fff">Book a review</a>
    <a href="#" style="padding:16px 32px;border-radius:999px;background:#fff">See the work</a>
  </div>`,
}));
const row = written.roots[0].id;
const kids = JSON.parse(await call('get_children', { id: row }));
const cmp = JSON.parse(await call('create_component', { id: kids[0].id, name: 'Button' }));
// Two instances of the same component, which is the case in the screenshot:
// two identical buttons, and the tree has to distinguish them.
await call('insert_instance', { componentId: cmp.componentId, parentId: row });

const browser = await chromium.launch({ headless: true });
const errors = [];
const view = await browser.newPage({ viewport: { width: 1500, height: 950 } });
view.on('pageerror', (e) => errors.push(e.message));
await view.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await view.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await view.waitForTimeout(2500);

/** Where the canvas says the selection is, and where the element actually is. */
const drawn = (id) => view.evaluate((nodeId) => {
  const box = document.querySelector('.overlay-selected');
  const frames = [...document.querySelectorAll('.artboard-frame iframe')];
  let el = null;
  let frame = null;
  for (const f of frames) {
    const d = f.contentDocument;
    if (!d) continue;
    const exact = d.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    const parts = exact ? [exact] : [...d.querySelectorAll(`[data-node-id^="${CSS.escape(nodeId)}::"]`)];
    const found = exact ?? parts.find((e) => !parts.some((o) => o !== e && o.contains(e)));
    if (found) { el = found; frame = f; break; }
  }
  if (!box || !el) return { box: !!box, el: !!el };
  const b = box.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  const scale = f.width / (frame.offsetWidth || f.width || 1);
  const r = el.getBoundingClientRect();
  return {
    box: true, el: true,
    dx: Math.abs(b.left - (f.left + r.left * scale)),
    dy: Math.abs(b.top - (f.top + r.top * scale)),
    dw: Math.abs(b.width - r.width * scale),
  };
}, id);

const ids = await view.evaluate((r) => {
  const doc = window.__playground.store.getState().doc;
  const children = doc.nodes[r].children;
  return {
    plain: children.find((c) => doc.nodes[c].type !== 'instance'),
    instances: children.filter((c) => doc.nodes[c].type === 'instance'),
  };
}, row);

// The tree opens artboards and nothing else, so open the way down first.
for (const id of [row]) {
  await view.click(`.layer-row[data-layer-id="${id}"] .layer-twisty`);
  await view.waitForTimeout(400);
}

// Clicked in the tree, not set in the store: the click path is the thing.
const clickRow = async (id) => {
  await view.click(`.layer-row[data-layer-id="${id}"]`);
  await view.waitForTimeout(500);
};

await clickRow(ids.plain);
const plain = await drawn(ids.plain);
check('an ordinary layer picked in the tree is outlined on the canvas',
  plain.box && plain.dx < 2 && plain.dy < 2, JSON.stringify(plain));

await clickRow(ids.instances[0]);
const first = await drawn(ids.instances[0]);
check('a component instance is outlined too',
  first.box && first.dx < 2 && first.dy < 2 && first.dw < 2, JSON.stringify(first));

const firstLeft = await view.evaluate(() => document.querySelector('.overlay-selected').getBoundingClientRect().left);
await clickRow(ids.instances[1]);
const second = await drawn(ids.instances[1]);
const secondLeft = await view.evaluate(() => document.querySelector('.overlay-selected').getBoundingClientRect().left);
check('and the second instance of the same component is outlined where it is, not where the first one is',
  second.box && second.dx < 2 && second.dw < 2, JSON.stringify(second));
check('the two instances are told apart — identical components, different boxes',
  Math.abs(secondLeft - firstLeft) > 20, `${Math.round(firstLeft)} vs ${Math.round(secondLeft)}`);

// The name badge follows, so it is clear *what* is selected and not only where.
check('the selection is labelled with the layer name',
  (await view.locator('.overlay-tag.is-selected').count()) === 1,
  await view.locator('.overlay-tag.is-selected').innerText().catch(() => ''));

// Hovering a row in the tree previews the same box on the canvas.
await view.evaluate(() => window.__playground.store.getState().select([]));
await view.hover(`.layer-row[data-layer-id="${ids.instances[1]}"]`);
await view.waitForTimeout(400);
check('hovering an instance in the tree previews it on the canvas',
  (await view.locator('.overlay-hover, .overlay-hovered').count()) > 0);

// And a layer inside an instance, which is addressed by the expanded key.
const innerKey = await view.evaluate((id) => {
  const frames = [...document.querySelectorAll('.artboard-frame iframe')];
  for (const f of frames) {
    const parts = [...(f.contentDocument?.querySelectorAll(`[data-node-id^="${CSS.escape(id)}::"]`) ?? [])];
    const deep = parts.find((e) => !e.querySelector('[data-node-id]'));
    if (deep) return deep.getAttribute('data-node-id');
  }
  return null;
}, ids.instances[0]);
if (innerKey) {
  await view.evaluate((k) => window.__playground.store.getState().select([k]), innerKey);
  await view.waitForTimeout(500);
  const inner = await drawn(innerKey);
  check('a layer inside an instance is outlined as itself', inner.box && inner.dx < 2, JSON.stringify(inner));
} else {
  check('a layer inside an instance is outlined as itself', false, 'no inner node found');
}

await view.screenshot({ path: '/tmp/selection-sync.png' });
check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await client.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

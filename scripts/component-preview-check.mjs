/**
 * Component previews: the pictures, the tile grid, and the hover overlay.
 *
 *   node scripts/component-preview-check.mjs [base]
 *
 * The parts worth a machine are the ones that look fine in a screenshot and are
 * wrong anyway: a preview cached against the wrong thing (so editing a
 * component leaves the old picture), an overlay clipped by the panel it lives
 * in, and a tile count that only happens to be right at the width someone
 * looked at.
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

// --- A document with two components ----------------------------------------

const doc = (await (await fetch(`${BASE}/api/documents`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Preview check' }),
})).json()).document;

const raw = await (await fetch(`${BASE}/api/documents/${doc.id}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'preview check' }),
})).text();
const client = new Client({ name: 'preview-check', version: '1' });
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
  html: `<div style="display:flex;flex-direction:column;gap:24px;padding:40px;background:#fff">
    <span style="display:inline-flex;align-items:center;justify-content:center;padding:12px 24px;border-radius:999px;background:#1c1c1c;color:#fff;width:fit-content;font-size:14px">Book a review</span>
    <div style="display:flex;flex-direction:column;gap:12px;padding:28px;border:1px solid #ececec;border-radius:20px;background:#fff">
      <strong style="font-size:18px">A card</strong>
      <p style="margin:0;color:#666">With two lines of supporting copy so the preview has something in it.</p>
    </div>
  </div>`,
}));
const kids = JSON.parse(await call('get_children', { id: written.roots[0].id }));
const buttonCmp = JSON.parse(await call('create_component', { id: kids[0].id, name: 'Button' }));
const cardCmp = JSON.parse(await call('create_component', { id: kids[1].id, name: 'Card' }));

// --- The pictures -------------------------------------------------------------

const url = (id, size) => `${BASE}/api/documents/${doc.id}/components/${id}/preview${size ? `?size=${size}` : ''}`;

const small = await fetch(url(buttonCmp.componentId));
const smallBytes = Buffer.from(await small.arrayBuffer());
check('a component renders a preview', small.ok && smallBytes.length > 1000,
  `${small.status} ${(smallBytes.length / 1024).toFixed(1)}KB`);
check('and it is really an image', smallBytes[0] === 0xff && smallBytes[1] === 0xd8);

const large = await fetch(url(buttonCmp.componentId, 'lg'));
const largeBytes = Buffer.from(await large.arrayBuffer());
check('the hover size is a bigger picture, not the same one',
  largeBytes.length > smallBytes.length, `${(smallBytes.length / 1024).toFixed(1)}KB → ${(largeBytes.length / 1024).toFixed(1)}KB`);

const etag = small.headers.get('etag');
check('an unchanged component answers 304',
  (await fetch(url(buttonCmp.componentId), { headers: { 'if-none-match': etag ?? '' } })).status === 304);

// The cache is keyed to the component, not the document: editing one component
// must not throw away the other's picture, and must throw away its own.
const cardEtagBefore = (await fetch(url(cardCmp.componentId))).headers.get('etag');
await call('set_text_content', {
  updates: [{ id: JSON.parse(await call('get_node_info', { id: buttonCmp.definitionRoot })).id, text: 'Changed' }],
});
const buttonAfter = await fetch(url(buttonCmp.componentId));
check('editing a component re-renders its preview',
  buttonAfter.headers.get('etag') !== etag, `${etag} → ${buttonAfter.headers.get('etag')}`);
const cardAfter = await fetch(url(cardCmp.componentId));
check('and leaves every other preview cached',
  cardAfter.headers.get('etag') === cardEtagBefore, `${cardAfter.headers.get('etag')}`);

const missing = await fetch(`${BASE}/api/documents/${doc.id}/components/cmp_nope/preview`);
check('an unknown component is a 404, not a render attempt', missing.status === 404);

await client.close();

// --- In the panel ---------------------------------------------------------------

const browser = await chromium.launch({ headless: true });
const errors = [];

const openPanel = async (page) => {
  await page.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
  if (await page.locator('.panel-toggle').count()) {
    await page.click('.panel-toggle');
    await page.waitForTimeout(350);
  }
  await page.click('.rail-left .rail-tabs button[aria-label="Components"]');
  await page.waitForTimeout(2500);
};

const wide = await browser.newPage({ viewport: { width: 1500, height: 950 } });
wide.on('pageerror', (e) => errors.push(e.message));
await openPanel(wide);

const loaded = await wide.evaluate(() =>
  [...document.querySelectorAll('.component-preview img')].filter((i) => i.complete && i.naturalWidth > 0).length);
check('every tile shows its picture', loaded === 2, `${loaded} of 2`);

/**
 * Columns the grid is laying out — not tiles on the first row, which cannot
 * exceed however many components the document happens to have.
 */
const columns = (page) => page.evaluate(() => {
  const grid = document.querySelector('.component-grid');
  if (!grid) return 0;
  return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
});
check('the docked rail lays out two columns', (await columns(wide)) === 2, `${await columns(wide)}`);

// --- The overlay ------------------------------------------------------------------

await wide.hover('.component-tile .component-preview');
// The large render may be cold; the overlay stays hidden until its picture is in.
await wide.waitForTimeout(2500);
const overlay = await wide.locator('.component-overlay');
check('hovering a tile opens an overlay', (await overlay.count()) === 1);

const geometry = await wide.evaluate(() => {
  const el = document.querySelector('.component-overlay');
  const tile = document.querySelector('.component-tile');
  const rail = document.querySelector('.rail-left');
  if (!el || !tile || !rail) return null;
  const o = el.getBoundingClientRect();
  const t = tile.querySelector('.component-preview').getBoundingClientRect();
  const r = rail.getBoundingClientRect();
  const img = el.querySelector('img');
  return {
    inside: o.left >= 0 && o.top >= 0 && o.right <= window.innerWidth && o.bottom <= window.innerHeight,
    clear: o.left >= r.right - 1,
    biggerThanTile: o.width > t.width * 1.8,
    // Portalled out of the rail, or the rail's own overflow would clip it.
    escaped: !rail.contains(el),
    natural: img ? img.naturalWidth : 0,
  };
});
check('it is placed clear of the rail and inside the window',
  geometry?.inside && geometry?.clear, JSON.stringify(geometry));
check('it is drawn outside the panel, so nothing clips it', geometry?.escaped);
check('and shows a bigger rendering than the tile', geometry?.biggerThanTile && geometry.natural > 400,
  `${geometry?.natural}px wide source`);

await wide.mouse.move(1200, 800);
await wide.waitForTimeout(400);
check('it closes when the pointer leaves', (await wide.locator('.component-overlay').count()) === 0);

await wide.screenshot({ path: '/tmp/component-preview-check.png' });
await wide.close();

const narrow = await browser.newPage({ viewport: { width: 430, height: 900 } });
narrow.on('pageerror', (e) => errors.push(e.message));
await openPanel(narrow);
check('the wider drawer lays out three', (await columns(narrow)) === 3, `${await columns(narrow)}`);
await narrow.close();

check('no runtime errors', errors.length === 0, errors[0] ?? '');
await browser.close();
await fetch(`${BASE}/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
